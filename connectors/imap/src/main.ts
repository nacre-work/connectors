/**
 * The imap connector. Every variable it reads is in README.md, which
 * `lint:config` holds in both directions.
 */
import { createRequire } from 'node:module'
import { boolean, compile, ConfigError, integer, optional, required, runConnector } from '@nacre.work/connector-kit'
import { imapMailbox } from './imap.js'
import { ImapSource, parseImapUrl, parseSince } from './source.js'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

const url = required('IMAP_URL')
const mailbox = parseImapUrl(url)
const since = parseSince(optional('IMAP_SINCE', ''))
// Compiled here so a malformed template is refused by the variable's name;
// the mapping below reads what these render.
const layer = compile(required('IMAP_LAYER'), 'IMAP_LAYER')
const title = compile(optional('IMAP_TITLE', '${subject|(no subject)}'), 'IMAP_TITLE')
const maxBytes = integer('IMAP_MAX_BYTES', 10_485_760, { min: 1024 })

/** `key=template;key=template`, each key one the connector does not already write. */
function parseMetadata(spec: string): Record<string, string> {
  const fixed = new Set(['connector', 'source', 'folder', 'message_id', 'from', 'date', 'filename'])
  const out: Record<string, string> = {}
  for (const part of spec.split(';')) {
    const entry = part.trim()
    if (entry === '') continue
    const eq = entry.indexOf('=')
    if (eq <= 0) throw new ConfigError(`IMAP_METADATA: ${JSON.stringify(entry)} is not key=template`)
    const key = entry.slice(0, eq).trim()
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new ConfigError(`IMAP_METADATA: key ${JSON.stringify(key)} must be lower-case letters, digits and underscores`)
    if (fixed.has(key)) throw new ConfigError(`IMAP_METADATA: ${key} is written by the connector itself; pick another key`)
    compile(entry.slice(eq + 1).trim(), `IMAP_METADATA (${key})`)
    out[key] = entry.slice(eq + 1).trim()
  }
  return out
}

await runConnector({
  name: 'imap',
  version,
  source: url,
  maxBytes,
  mapping: {
    layer: '${layer}',
    externalId: '${id}',
    title: '${title}',
    content: '${text}',
    metadata: {
      folder: '${folder}',
      message_id: '${message_id|}',
      from: '${from|}',
      date: '${date|}',
      filename: '${filename|}',
      ...parseMetadata(optional('IMAP_METADATA', '')),
    },
  },
  async open() {
    return new ImapSource({
      mailbox: imapMailbox(mailbox),
      folder: mailbox.folder,
      since,
      layer,
      title,
      attachments: boolean('IMAP_ATTACHMENTS', true),
      maxBytes,
    })
  },
})
