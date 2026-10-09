import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile, compileMapping, State, sweep, type Index, type Mapped } from '@nacre.work/connector-kit'
import { simpleParser } from 'mailparser'
import { describe, expect, it } from 'vitest'
import { headerFields, ImapSource, parseImapUrl, parseSince, type Folder, type Mailbox, type MailboxMessage } from '../source.js'

/**
 * A folder in memory over raw RFC 822 messages: the listing describes each
 * one the way a server does — envelope, header block, the attachments the
 * structure declares — and a download counts, so the suite can see that the
 * message with two attachments was read once. `simpleParser` plays the
 * server's part in describing a message, which is the parser the source uses
 * on the bytes it downloads; the description is built from the raw text and
 * nothing of the source's own reading leaks into it.
 */
class MemoryMailbox implements Mailbox {
  readonly messages = new Map<number, string>()
  readonly downloads: number[] = []
  uidValidity = '1700000000'
  broken = false
  #uid = 0

  append(raw: string): number {
    this.messages.set(++this.#uid, raw)
    return this.#uid
  }

  async open(): Promise<Folder> {
    const { messages, downloads, broken } = this
    return {
      uidValidity: this.uidValidity,
      async *messages(since: Date | undefined): AsyncIterable<MailboxMessage> {
        if (broken) throw new Error('the server closed the connection')
        for (const [uid, raw] of messages) {
          const mail = await simpleParser(raw)
          if (since !== undefined && mail.date !== undefined && mail.date < since) continue
          const from = mail.from?.value ?? []
          const to = (Array.isArray(mail.to) ? mail.to[0]?.value : mail.to?.value) ?? []
          yield {
            uid,
            size: Buffer.byteLength(raw),
            messageId: mail.messageId,
            subject: mail.subject,
            from: from.map((a) => ({ name: a.name, address: a.address })),
            to: to.map((a) => ({ name: a.name, address: a.address })),
            date: mail.date,
            headers: raw.slice(0, raw.indexOf('\r\n\r\n')),
            attachments: mail.attachments.flatMap((a) => (a.filename === undefined ? [] : [{ filename: a.filename, contentType: a.contentType }])),
          }
        }
      },
      async source(uid: number) {
        downloads.push(uid)
        const raw = messages.get(uid)
        if (raw === undefined) throw new Error(`no such uid ${String(uid)}`)
        return new TextEncoder().encode(raw)
      },
      async close() {},
    }
  }
}

class FakeIndex implements Index {
  readonly adds: Mapped[] = []
  readonly removes: string[] = []
  #n = 0
  async add(doc: Mapped) {
    this.adds.push(doc)
    return { documentId: `doc-${String(++this.#n)}`, unchanged: false }
  }
  async remove(id: string) {
    this.removes.push(id)
    return true
  }
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A message as a client would store it, CRLF throughout, with the attachments base64-encoded. */
function message(o: {
  id?: string
  subject: string
  from?: string
  to?: string
  date?: string
  layer?: string
  text: string
  html?: boolean
  attachments?: { filename: string; type: string; bytes: Uint8Array }[]
}): string {
  const head = [
    `From: ${o.from ?? 'Alice <alice@example.com>'}`,
    `To: ${o.to ?? 'Team <team@example.com>'}`,
    `Subject: ${o.subject}`,
    `Date: ${o.date ?? 'Mon, 01 Jun 2026 10:00:00 +0000'}`,
    ...(o.id === undefined ? [] : [`Message-ID: <${o.id}>`]),
    ...(o.layer === undefined ? [] : [`X-Layer: ${o.layer}`]),
    'MIME-Version: 1.0',
  ]
  const body = o.html === true ? `<p>${o.text}</p>` : o.text
  const bodyType = o.html === true ? 'text/html' : 'text/plain'
  if (o.attachments === undefined || o.attachments.length === 0) {
    return [...head, `Content-Type: ${bodyType}; charset=utf-8`, '', body, ''].join('\r\n')
  }
  const lines = [...head, 'Content-Type: multipart/mixed; boundary="b1"', '', '--b1', `Content-Type: ${bodyType}; charset=utf-8`, '', body]
  for (const a of o.attachments) {
    lines.push(
      '--b1',
      `Content-Type: ${a.type}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
      '',
      Buffer.from(a.bytes).toString('base64'),
    )
  }
  lines.push('--b1--', '')
  return lines.join('\r\n')
}

const mapping = compileMapping({
  layer: '${layer}',
  externalId: '${id}',
  title: '${title}',
  content: '${text}',
  metadata: { folder: '${folder}', message_id: '${message_id|}', from: '${from|}', date: '${date|}', filename: '${filename|}' },
})
const quiet = { skipped: () => undefined, failed: () => undefined }
const provenance = { connector: 'imap', source: 'memory' }
const state = () => new State(join(mkdtempSync(join(tmpdir(), 'imap-')), 'state.sqlite'))

function source(mailbox: Mailbox, o: { since?: string; layer?: string; attachments?: boolean } = {}) {
  return new ImapSource({
    mailbox,
    folder: 'INBOX',
    since: parseSince(o.since ?? ''),
    layer: compile(o.layer ?? '${header_x_layer}', 'IMAP_LAYER'),
    title: compile('${subject|(no subject)}', 'IMAP_TITLE'),
    attachments: o.attachments ?? true,
    maxBytes: 4096,
  })
}

describe('the three verbs over a folder', () => {
  it('adds a message and the attachments the index reads, skips the rest, changes a re-appended copy, and removes what left', async () => {
    const box = new MemoryMailbox()
    box.append(
      message({
        id: 'leave-1@example.com',
        subject: 'leave.md',
        layer: 'handbook',
        text: 'The word alphaleave appears only in this message.',
        attachments: [
          { filename: 'budget.docx', type: 'application/octet-stream', bytes: DOCX_BYTES },
          { filename: 'chart.png', type: 'image/png', bytes: PNG_BYTES },
        ],
      }),
    )
    const code = box.append(message({ id: 'code-1@example.com', subject: 'a.ts', layer: 'code', text: 'export const codeword = "betacode"', html: true }))
    box.append(message({ id: 'big-1@example.com', subject: 'big', layer: 'handbook', text: 'x'.repeat(8192) }))
    box.append(message({ id: 'nolayer-1@example.com', subject: 'unrouted', text: 'no X-Layer header' }))
    const index = new FakeIndex()
    const st = state()
    const skipped: string[] = []
    const report = { skipped: (reason: string, item: string) => void skipped.push(`${reason}:${item}`), failed: () => undefined }

    const first = await sweep({ source: source(box), mapping, index, state: st, provenance, report })
    expect(first).toMatchObject({ complete: true, added: 3, skipped: { binary: 1, oversize: 1, missing_field: 1 } })
    expect(skipped.sort()).toEqual(['binary:leave-1@example.com/chart.png', 'missing_field:nolayer-1@example.com', 'oversize:big-1@example.com'])
    // One download per message read: the message with two attachments was
    // read once, the oversize one never, the unrouted one never.
    expect(box.downloads).toEqual([1, code])

    const byId = Object.fromEntries(index.adds.map((d) => [d.externalId, d]))
    expect(byId['leave-1@example.com']).toMatchObject({
      layer: 'handbook',
      title: 'leave.md',
      content: 'The word alphaleave appears only in this message.',
      metadata: { folder: 'INBOX', message_id: 'leave-1@example.com', from: 'alice@example.com', date: '2026-06-01T10:00:00.000Z', filename: '' },
    })
    // HTML only: the parser's text of it.
    expect(byId['code-1@example.com']).toMatchObject({ layer: 'code', content: 'export const codeword = "betacode"' })
    // The attachment: bytes under the type its name says, the message's layer, its own title.
    expect(byId['leave-1@example.com/budget.docx']).toMatchObject({
      layer: 'handbook',
      title: 'budget.docx',
      contentType: DOCX,
      content: undefined,
      metadata: { message_id: 'leave-1@example.com', filename: 'budget.docx' },
    })
    expect(byId['leave-1@example.com/budget.docx']?.bytes).toEqual(DOCX_BYTES)

    // Nothing moved: nothing downloaded.
    box.downloads.length = 0
    const second = await sweep({ source: source(box), mapping, index, state: st, provenance, report: quiet })
    expect(second).toMatchObject({ added: 0, changed: 0, unchanged: 3, removed: 0 })
    expect(box.downloads).toEqual([])

    // A client re-appends a corrected copy under the same Message-ID: a new
    // UID, so a new version; the same identity, so a change and not a
    // removal plus an add. Its attachment is downloaded with it and found
    // unchanged by the hash.
    box.messages.delete(1)
    box.append(
      message({
        id: 'leave-1@example.com',
        subject: 'leave.md',
        layer: 'handbook',
        text: 'The word gammaleave replaced the old one.',
        attachments: [{ filename: 'budget.docx', type: 'application/octet-stream', bytes: DOCX_BYTES }],
      }),
    )
    const third = await sweep({ source: source(box), mapping, index, state: st, provenance, report: quiet })
    expect(third).toMatchObject({ added: 0, changed: 1, unchanged: 2, removed: 0 })
    expect(index.adds.at(-1)).toMatchObject({ externalId: 'leave-1@example.com', content: 'The word gammaleave replaced the old one.' })
    expect(index.removes).toEqual([])

    // A message that left the folder.
    box.messages.delete(code)
    const fourth = await sweep({ source: source(box), mapping, index, state: st, provenance, report: quiet })
    expect(fourth).toMatchObject({ changed: 0, removed: 1, unchanged: 2 })
    // The third add was a.ts: leave.md, its docx, then the code message.
    expect(index.removes).toEqual(['doc-3'])

    // The folder rebuilt: every version moves, every message is read again,
    // and the hash says nothing changed.
    box.uidValidity = '1700000001'
    box.downloads.length = 0
    const fifth = await sweep({ source: source(box), mapping, index, state: st, provenance, report: quiet })
    expect(fifth).toMatchObject({ added: 0, changed: 0, unchanged: 2, removed: 0 })
    expect(box.downloads).toHaveLength(1)
  })

  it('removes nothing when the listing throws', async () => {
    const box = new MemoryMailbox()
    box.append(message({ id: 'm1@example.com', subject: 'one', layer: 'handbook', text: 'one' }))
    const index = new FakeIndex()
    const st = state()
    await sweep({ source: source(box), mapping, index, state: st, provenance, report: quiet })
    box.broken = true
    const broken = await sweep({ source: source(box), mapping, index, state: st, provenance, report: quiet })
    expect(broken).toMatchObject({ complete: false, removed: 0, error: 'the server closed the connection' })
    expect(index.removes).toEqual([])
  })

  it('leaves attachments out when IMAP_ATTACHMENTS is false', async () => {
    const box = new MemoryMailbox()
    box.append(
      message({
        id: 'm1@example.com',
        subject: 'one',
        layer: 'handbook',
        text: 'one',
        attachments: [{ filename: 'budget.docx', type: DOCX, bytes: DOCX_BYTES }],
      }),
    )
    const items = []
    for await (const item of source(box, { attachments: false }).list()) items.push(item.id)
    expect(items).toEqual(['m1@example.com'])
  })

  it('lists only messages on or after IMAP_SINCE, so moving the date removes what fell behind it', async () => {
    const box = new MemoryMailbox()
    box.append(message({ id: 'old@example.com', subject: 'old', layer: 'handbook', text: 'old', date: 'Fri, 01 May 2026 10:00:00 +0000' }))
    box.append(message({ id: 'new@example.com', subject: 'new', layer: 'handbook', text: 'new', date: 'Mon, 01 Jun 2026 10:00:00 +0000' }))
    const index = new FakeIndex()
    const st = state()
    const all = await sweep({ source: source(box), mapping, index, state: st, provenance, report: quiet })
    expect(all).toMatchObject({ added: 2 })
    const bounded = await sweep({ source: source(box, { since: '2026-05-15' }), mapping, index, state: st, provenance, report: quiet })
    expect(bounded).toMatchObject({ listed: 1, unchanged: 1, removed: 1 })
    expect(index.removes).toEqual(['doc-1'])
  })

  it('falls back to uidvalidity:uid for a message with no Message-ID, and offers every header as a field', async () => {
    const box = new MemoryMailbox()
    const uid = box.append(message({ subject: 'anonymous', layer: 'handbook', text: 'no id' }))
    const items = []
    for await (const item of source(box, { layer: '${header_x_layer}-${to_user}' }).list()) items.push(item)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: `1700000000:${String(uid)}`,
      version: `1700000000:${String(uid)}`,
      fields: {
        layer: 'handbook-team',
        title: 'anonymous',
        header_x_layer: 'handbook',
        header_subject: 'anonymous',
        header_from: 'Alice <alice@example.com>',
        from: 'alice@example.com',
        to: 'team@example.com',
        to_user: 'team',
        folder: 'INBOX',
        uid,
      },
    })
    expect(items[0]?.fields['message_id']).toBeUndefined()
  })
})

describe('headers as fields', () => {
  it('unfolds, lower-cases, keeps the first of a repeated header, and spells the name as a field reference', () => {
    const fields = headerFields('Received: from a\r\nReceived: from b\r\nX-Layer: handbook\r\nContent-Type: text/plain;\r\n charset=utf-8\r\nX.Odd Name: v')
    expect(fields).toEqual({
      header_received: 'from a',
      header_x_layer: 'handbook',
      header_content_type: 'text/plain; charset=utf-8',
      header_x_odd_name: 'v',
    })
  })
})

describe('IMAP_URL', () => {
  it('reads the folder from the path and defaults it to INBOX, with the scheme deciding TLS and the port', () => {
    expect(parseImapUrl('imaps://alice:secret@mail.example.com')).toEqual({
      host: 'mail.example.com',
      port: 993,
      secure: true,
      user: 'alice',
      password: 'secret',
      folder: 'INBOX',
    })
    expect(parseImapUrl('imap://live%40example.com:live@localhost:3143/Archive/2026')).toMatchObject({
      port: 3143,
      secure: false,
      user: 'live@example.com',
      folder: 'Archive/2026',
    })
  })

  it('refuses a malformed one by name', () => {
    expect(() => parseImapUrl('not a url')).toThrow(/^IMAP_URL is not a URL/)
    expect(() => parseImapUrl('https://alice:secret@mail.example.com/INBOX')).toThrow(/^IMAP_URL has the scheme https:/)
    expect(() => parseImapUrl('imaps://mail.example.com/INBOX')).toThrow(/^IMAP_URL carries no user and password/)
    expect(() => parseImapUrl('imaps://alice:secret@mail.example.com/INBOX?x=1')).toThrow(/^IMAP_URL carries a query/)
  })

  it('reads IMAP_SINCE as a day and refuses anything else by name', () => {
    expect(parseSince('')).toBeUndefined()
    expect(parseSince('2026-05-15')?.toISOString()).toBe('2026-05-15T00:00:00.000Z')
    expect(() => parseSince('15/05/2026')).toThrow(/^IMAP_SINCE is "15\/05\/2026"/)
    expect(() => parseSince('2026-13-40')).toThrow(/^IMAP_SINCE/)
  })
})
