/**
 * The sql connector. Every variable it reads is in README.md, which
 * `lint:config` holds in both directions.
 */
import { createRequire } from 'node:module'
import { integer, optional, required, runConnector } from '@nacre.work/connector-kit'
import { driverFor, openQuery } from './db.js'
import { column, parseMetadata, SqlSource } from './source.js'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

const url = required('SQL_URL')
driverFor(url)
const statement = required('SQL_QUERY')
const idColumn = column('SQL_ID', optional('SQL_ID', 'id'))
const versionRaw = process.env['SQL_VERSION']?.trim() || undefined
const versionColumn = versionRaw === undefined ? undefined : column('SQL_VERSION', versionRaw)
const maxBytes = integer('SQL_MAX_BYTES', 10_485_760, { min: 1024 })

await runConnector({
  name: 'sql',
  version,
  source: url,
  maxBytes,
  mapping: {
    layer: required('SQL_LAYER'),
    externalId: optional('SQL_EXTERNAL_ID', `\${${idColumn}}`),
    title: optional('SQL_TITLE', '${title}'),
    content: optional('SQL_CONTENT', '${content}'),
    metadata: { ...parseMetadata(optional('SQL_METADATA', ''), 'SQL_METADATA'), row_id: `\${${idColumn}}` },
  },
  async open() {
    return new SqlSource({ query: openQuery(url, statement), idColumn, versionColumn })
  },
})
