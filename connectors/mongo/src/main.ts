/**
 * The mongo connector. Every variable it reads is in README.md, which
 * `lint:config` holds in both directions.
 */
import { createRequire } from 'node:module'
import { compile, ConfigError, integer, optional, required, runConnector } from '@nacre.work/connector-kit'
import { mongoCollection, parseUrl } from './driver.js'
import { MongoSource, parseJsonObject, parseMetadata, parsePath, parseProjection } from './source.js'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/** A template refused at startup by the variable's name, not by the mapping slot it fills. */
function template(name: string, source: string): string {
  try {
    compile(source, name)
  } catch (e) {
    throw new ConfigError(e instanceof Error ? e.message : String(e))
  }
  return source
}

const url = required('MONGO_URL')
let parsed: ReturnType<typeof parseUrl>
try {
  parsed = parseUrl(url)
} catch (e) {
  throw new ConfigError(`MONGO_URL is not a connection string: ${e instanceof Error ? e.message : String(e)}`)
}
const database = optional('MONGO_DATABASE', parsed.database ?? '')
if (database === '') throw new ConfigError('MONGO_DATABASE is not set and MONGO_URL names no database; one of them has to')
const collection = required('MONGO_COLLECTION')
const filter = parseJsonObject('MONGO_FILTER', optional('MONGO_FILTER', '{}'))
const projectionRaw = process.env['MONGO_PROJECTION']?.trim() || undefined
const projection = projectionRaw === undefined ? undefined : parseProjection('MONGO_PROJECTION', projectionRaw)
const id = parsePath('MONGO_ID', optional('MONGO_ID', '_id'))
const versionRaw = process.env['MONGO_VERSION']?.trim() || undefined
const versionField = versionRaw === undefined ? undefined : parsePath('MONGO_VERSION', versionRaw)
const title = process.env['MONGO_TITLE']?.trim() || undefined
const maxBytes = integer('MONGO_MAX_BYTES', 10_485_760, { min: 1024 })
const metadata = Object.fromEntries(
  Object.entries(parseMetadata('MONGO_METADATA', optional('MONGO_METADATA', ''))).map(([key, source]) => [key, template(`MONGO_METADATA (${key})`, source)]),
)

await runConnector({
  name: 'mongo',
  version,
  source: `${parsed.origin}/${database}/${collection}`,
  maxBytes,
  mapping: {
    layer: template('MONGO_LAYER', required('MONGO_LAYER')),
    externalId: template('MONGO_EXTERNAL_ID', optional('MONGO_EXTERNAL_ID', '${doc_id}')),
    ...(title === undefined ? {} : { title: template('MONGO_TITLE', title) }),
    content: template('MONGO_CONTENT', optional('MONGO_CONTENT', '${content}')),
    // The operator's keys first and the connector's two last, so `collection`
    // and `doc_id` are what their names say on every document.
    metadata: { ...metadata, collection, doc_id: '${doc_id}' },
  },
  async open() {
    let source: ReturnType<typeof mongoCollection>
    try {
      source = mongoCollection({ url, database, collection })
    } catch (e) {
      // The driver refuses a string its grammar admits but it cannot use —
      // an unknown option, a bad escape — and the message names the part,
      // never the string.
      throw new ConfigError(`MONGO_URL: ${e instanceof Error ? e.message : String(e)}`)
    }
    return new MongoSource({ collection: source, filter, projection, id, version: versionField })
  },
})
