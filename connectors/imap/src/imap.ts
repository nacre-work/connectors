/**
 * The folder, through `imapflow`. This is the one place the client is named.
 *
 * One connection per sweep, opened by `list()` and closed when the listing
 * ends; the folder is selected read-only, because a connector that only
 * reads must not be a connector that can mark anything. The listing is a
 * `SEARCH` for the UIDs in scope and then `FETCH` of the description in
 * pages, never the generator form: `imapflow`'s `fetch()` holds the
 * connection open with backpressure until the consumer has read every row,
 * and the engine downloads a message between two rows — a download issued
 * while that generator is live waits for a listing that waits for the
 * download. A page is read whole, so between pages the line is free.
 *
 * The message source is `fetchOne` with `source: true`, bounded before it is
 * asked by the size the listing carried.
 */
import { ImapFlow, type MessageAddressObject, type MessageStructureObject } from 'imapflow'
import type { Address, AttachedPart, Folder, ImapUrl, Mailbox, MailboxMessage } from './source.js'

/** How many messages one FETCH describes; a folder of a hundred thousand is five hundred round trips, not one answer held in memory. */
const PAGE = 200

export function imapMailbox(o: ImapUrl): Mailbox {
  return {
    async open(): Promise<Folder> {
      const client = new ImapFlow({
        host: o.host,
        port: o.port,
        secure: o.secure,
        auth: { user: o.user, pass: o.password },
        logger: false,
        disableAutoIdle: true,
      })
      await client.connect()
      let lock
      try {
        lock = await client.getMailboxLock(o.folder, { readOnly: true })
      } catch (e) {
        await client.logout().catch(() => undefined)
        throw e
      }
      const box = client.mailbox
      if (box === false) throw new Error(`the folder ${JSON.stringify(o.folder)} could not be selected`)
      return {
        uidValidity: String(box.uidValidity),
        async *messages(since) {
          if (box.exists === 0) return
          const uids = await client.search(since === undefined ? { all: true } : { since }, { uid: true })
          if (uids === false || uids === undefined) throw new Error(`the server did not answer a search of ${JSON.stringify(o.folder)}`)
          for (let i = 0; i < uids.length; i += PAGE) {
            const page = await client.fetchAll(
              uids.slice(i, i + PAGE),
              { uid: true, size: true, envelope: true, headers: true, bodyStructure: true },
              { uid: true },
            )
            for (const m of page) {
              const envelope = m.envelope ?? {}
              const date = envelope.date === undefined ? undefined : new Date(envelope.date)
              yield {
                uid: m.uid,
                size: m.size ?? 0,
                messageId: envelope.messageId,
                subject: envelope.subject,
                from: addresses(envelope.from),
                to: addresses(envelope.to),
                date: date === undefined || Number.isNaN(date.getTime()) ? undefined : date,
                headers: (m.headers ?? Buffer.alloc(0)).toString('utf8'),
                attachments: m.bodyStructure === undefined ? [] : attached(m.bodyStructure, []),
              } satisfies MailboxMessage
            }
          }
        },
        async source(uid) {
          const m = await client.fetchOne(String(uid), { source: true }, { uid: true })
          if (m === false || m === undefined || m.source === undefined) {
            throw new Error(`message ${String(uid)} in ${JSON.stringify(o.folder)} could not be downloaded`)
          }
          return new Uint8Array(m.source)
        },
        async close() {
          lock.release()
          await client.logout()
        },
      }
    },
  }
}

function addresses(list: readonly MessageAddressObject[] | undefined): Address[] {
  return (list ?? []).map((a) => ({ name: a.name, address: a.address }))
}

/**
 * The leaves of the body structure that carry a filename, in order. A part
 * with a name is attached whatever its disposition — an inline `report.pdf`
 * is still a document — and a part without one is the body, not a file.
 */
function attached(node: MessageStructureObject, out: AttachedPart[]): AttachedPart[] {
  if (node.childNodes !== undefined) {
    for (const child of node.childNodes) attached(child, out)
    return out
  }
  const filename = node.dispositionParameters?.['filename'] ?? node.parameters?.['name']
  if (filename !== undefined && filename !== '') out.push({ filename, contentType: node.type.toLowerCase() })
  return out
}
