/**
 * A mailbox folder as a source. The listing is every message in one folder
 * on or after `IMAP_SINCE`, read as the server describes it — UID, envelope,
 * headers and **body structure**, so a message's attachments are known by
 * name and declared type without a byte of the body being downloaded — and
 * one message is one document, plus one per attachment of a type the index
 * reads as a file.
 *
 * Identity and version are deliberately two different things. A message's
 * **identity is its `Message-ID`**, the header a sender writes once and that
 * survives every move, copy and re-append; a message with none falls back to
 * `uidvalidity:uid`, which is as stable as the folder is. Its **version is
 * `uidvalidity:uid`**: a message never changes in place, but mail clients
 * re-append a corrected copy under the same `Message-ID` — a draft saved
 * again, a note edited in an app that stores notes as mail — and under this
 * split that is a *change* to one document rather than a removal and an add
 * of two. A message that left the folder is a document that leaves the index.
 * And a changed `UIDVALIDITY` — a folder rebuilt by the server — re-versions
 * every message, which is correct and costs one download each: the content
 * hash still decides whether the index is touched, and it is not.
 *
 * The listing never downloads; `fetch` downloads a message's source once per
 * sweep and parses it, keeping the parse for the attachment items that follow
 * the message in the listing, so a message with two attachments is read once.
 * The parser is `mailparser`; the IMAP client is behind the `Mailbox` port and
 * lives in `imap.ts`, so the suite drives this source over a folder in memory.
 */
import { simpleParser, type ParsedMail } from 'mailparser'
import {
  binaryContentType,
  ConfigError,
  contentTypeForExtension,
  MissingField,
  type Fields,
  type Item,
  type Source,
  type Template,
} from '@nacre.work/connector-kit'

export interface Address {
  readonly name: string | undefined
  readonly address: string | undefined
}

/** A part the body structure declares with a filename: what is attached, and nothing of its bytes. */
export interface AttachedPart {
  readonly filename: string
  readonly contentType: string
}

/** What a listing carries per message: the server's own description, no body. */
export interface MailboxMessage {
  readonly uid: number
  /** `RFC822.SIZE`: the whole message as stored, which bounds the download before it happens. */
  readonly size: number
  /** The `Message-ID` header as the server reports it, angle brackets included; absent when the message has none. */
  readonly messageId: string | undefined
  readonly subject: string | undefined
  readonly from: readonly Address[]
  readonly to: readonly Address[]
  readonly date: Date | undefined
  /** The raw header block, as stored. */
  readonly headers: string
  readonly attachments: readonly AttachedPart[]
}

/** One selected folder, for one sweep. */
export interface Folder {
  readonly uidValidity: string
  messages(since: Date | undefined): AsyncIterable<MailboxMessage>
  /** The whole message, RFC 822, as stored. */
  source(uid: number): Promise<Uint8Array>
  close(): Promise<void>
}

/** What the source needs of a server, and all it needs. */
export interface Mailbox {
  open(): Promise<Folder>
}

export interface ImapSourceOptions {
  readonly mailbox: Mailbox
  /** The folder's name, for the fields and the metadata. */
  readonly folder: string
  /** Only messages on or after it are listed; an older one is not in the listing and is treated as gone. */
  readonly since: Date | undefined
  /** `IMAP_LAYER`, over a message's fields. */
  readonly layer: Template
  /** `IMAP_TITLE`, over a message's fields; an attachment's title is its filename. */
  readonly title: Template
  readonly attachments: boolean
  readonly maxBytes: number
}

export class ImapSource implements Source {
  #folder: Folder | undefined
  #parsed: { readonly uid: number; readonly mail: Promise<ParsedMail> } | undefined

  constructor(private readonly o: ImapSourceOptions) {}

  async *list(): AsyncIterable<Item> {
    const folder = await this.o.mailbox.open()
    this.#folder = folder
    this.#parsed = undefined
    try {
      for await (const message of folder.messages(this.o.since)) {
        const version = `${folder.uidValidity}:${String(message.uid)}`
        const id = message.messageId === undefined ? version : bareMessageId(message.messageId)
        const fields: Record<string, unknown> = {
          ...headerFields(message.headers),
          id,
          uid: message.uid,
          uidvalidity: folder.uidValidity,
          folder: this.o.folder,
          size: message.size,
          ...(message.messageId === undefined ? {} : { message_id: id }),
          ...(message.subject === undefined ? {} : { subject: message.subject }),
          ...(message.from[0]?.address === undefined ? {} : { from: message.from[0].address }),
          ...(message.to[0]?.address === undefined ? {} : { to: message.to[0].address, to_user: localPart(message.to[0].address) }),
          ...(message.date === undefined ? {} : { date: message.date.toISOString() }),
        }
        // The layer and the title are decided here, from the listing's fields,
        // so an unchanged version never costs a download.
        yield this.item(id, version, fields, this.o.title)
        if (!this.o.attachments) continue

        const named = new Set<string>()
        for (const part of message.attachments) {
          // Two parts of one message under one name would be one id twice in
          // one listing; the first is the document.
          if (named.has(part.filename)) continue
          named.add(part.filename)
          const ext = part.filename.includes('.') ? part.filename.slice(part.filename.lastIndexOf('.') + 1).toLowerCase() : ''
          const own: Record<string, unknown> = { ...fields, id: `${id}/${part.filename}`, filename: part.filename, ext }
          // By the name's extension first, then by the declared type — the
          // type the index must be told, never sniffed.
          const contentType = contentTypeForExtension(ext) ?? binaryContentType(part.contentType)
          if (contentType === undefined) {
            yield { id: `${id}/${part.filename}`, version, fields: { ...own, skip: 'binary', skip_detail: `${part.contentType} is not a format the index reads as a file` } }
            continue
          }
          yield this.item(`${id}/${part.filename}`, version, { ...own, content_type: contentType }, undefined)
        }
      }
    } finally {
      this.#folder = undefined
      this.#parsed = undefined
      await folder.close()
    }
  }

  /** An item with its layer and title rendered, or one skipped for the field a template could not find. */
  private item(id: string, version: string, fields: Record<string, unknown>, title: Template | undefined): Item {
    try {
      const rendered = { ...fields, title: title === undefined ? String(fields['filename']) : title.render(fields) }
      return { id, version, fields: { ...rendered, layer: this.o.layer.render(rendered) } }
    } catch (e) {
      if (e instanceof MissingField) {
        return { id, version, fields: { ...fields, skip: 'missing_field', skip_detail: `${title === undefined ? 'IMAP_LAYER' : 'IMAP_LAYER or IMAP_TITLE'} reads ${e.field}, which this message does not carry` } }
      }
      throw e
    }
  }

  async fetch(item: Item): Promise<Fields> {
    if (typeof item.fields['skip'] === 'string') return {}
    const size = Number(item.fields['size'])
    // Before the download, because the listing already said how big it is.
    if (size > this.o.maxBytes) return { skip: 'oversize', skip_detail: `${String(size)} bytes, IMAP_MAX_BYTES is ${String(this.o.maxBytes)}` }

    const mail = await this.parsed(Number(item.fields['uid']))
    if (item.fields['filename'] === undefined) {
      // The text part; where there is only HTML, the parser's text of it.
      return { text: mail.text ?? '' }
    }
    const filename = String(item.fields['filename'])
    const part = mail.attachments.find((a) => a.filename === filename)
    if (part === undefined) return { skip: 'empty', skip_detail: `the structure names an attachment ${JSON.stringify(filename)} the parser did not find` }
    return { bytes: new Uint8Array(part.content) }
  }

  /** The message's source, downloaded and parsed once per sweep: the items of one message are listed together. */
  private parsed(uid: number): Promise<ParsedMail> {
    if (this.#parsed?.uid === uid) return this.#parsed.mail
    const folder = this.#folder
    if (folder === undefined) throw new Error('fetch outside a listing: the folder is open only while list() runs')
    const mail = folder.source(uid).then((bytes) => simpleParser(Buffer.from(bytes)))
    this.#parsed = { uid, mail }
    return mail
  }
}

/** `<id@host>` → `id@host`: the id, without the brackets the header syntax requires around it. */
function bareMessageId(header: string): string {
  return header.trim().replace(/^<|>$/g, '')
}

function localPart(address: string): string {
  const at = address.lastIndexOf('@')
  return at === -1 ? address : address.slice(0, at)
}

/**
 * Every header as a field, `header_<name>`: lower-case, anything that is not
 * a letter or a digit as `_`, so `X-Layer` is `header_x_layer`. The value is
 * the raw one, unfolded — the decoded subject and addresses are the envelope's
 * `subject`, `from` and `to` — and a header that repeats keeps its first value.
 */
export function headerFields(block: string): Record<string, string> {
  const lines: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (line === '') continue
    if (/^[ \t]/.test(line) && lines.length > 0) lines[lines.length - 1] += ` ${line.trim()}`
    else lines.push(line)
  }
  const out: Record<string, string> = {}
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = `header_${line.slice(0, colon).trim().toLowerCase().replace(/[^a-z0-9]/g, '_')}`
    if (!(key in out)) out[key] = line.slice(colon + 1).trim()
  }
  return out
}

export interface ImapUrl {
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly user: string
  readonly password: string
  readonly folder: string
}

/**
 * `imaps://user:password@host[:port]/Folder`, or `imap://` for a server on a
 * network that is trusted with the credential in the clear. The folder is the
 * path, `INBOX` when there is none; the credential is percent-decoded, so an
 * `@` in the user is written `%40`. Refused by name, naming the shape.
 */
export function parseImapUrl(value: string): ImapUrl {
  const shape = 'imaps://user:password@host[:port]/Folder (or imap:// for a server on a trusted network)'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`IMAP_URL is not a URL; it must be ${shape}`)
  }
  if (url.protocol !== 'imaps:' && url.protocol !== 'imap:') throw new ConfigError(`IMAP_URL has the scheme ${url.protocol}; it must be ${shape}`)
  if (url.hostname === '') throw new ConfigError(`IMAP_URL names no host; it must be ${shape}`)
  if (url.username === '' || url.password === '') throw new ConfigError(`IMAP_URL carries no user and password; it must be ${shape}`)
  if (url.search !== '' || url.hash !== '') throw new ConfigError(`IMAP_URL carries a query or a fragment; it must be ${shape}`)
  const secure = url.protocol === 'imaps:'
  const port = url.port === '' ? (secure ? 993 : 143) : Number(url.port)
  const folder = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  return {
    host: url.hostname,
    port,
    secure,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    folder: folder === '' ? 'INBOX' : folder,
  }
}

/** `YYYY-MM-DD` → that day, UTC; empty → none. */
export function parseSince(value: string): Date | undefined {
  if (value === '') return undefined
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(NaN)
  if (Number.isNaN(date.getTime())) throw new ConfigError(`IMAP_SINCE is ${JSON.stringify(value)}; it must be a date written YYYY-MM-DD`)
  return date
}
