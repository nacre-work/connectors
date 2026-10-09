/**
 * A collection as a source. The listing is every document a filter matches,
 * a document's **own fields are its mapping** — a template over them names
 * the layer, the title and the content — and a document absent from the
 * complete result is a document that leaves the index. A collection has no
 * editor-save race: a document the filter no longer returns was deleted, or
 * edited out of the filter, by somebody who meant it.
 *
 * There is nothing to fetch. A git tree lists hashes and reads the blobs that
 * moved; a cursor hands over the whole document, so the listing already holds
 * every field and `fetch` returns nothing. The version is what makes that
 * cheap rather than merely simple: a field the deployment names
 * (`MONGO_VERSION` — an `updated_at`, a revision number) is the version, and
 * an unchanged one is neither mapped nor hashed on the next sweep. Without
 * one the version is a hash over the document's canonical JSON — every value
 * as a template would see it, keys sorted at every depth — computed here,
 * over bytes the cursor has already delivered, so the engine's content hash
 * is still skipped for a document that did not move.
 *
 * What a template sees of a BSON value is decided here once, because the
 * two sides have to agree: an `ObjectId` is its hex string, a `Date` is ISO
 * 8601, a `Long` or a `Decimal128` is its decimal text, a UUID is its
 * hyphenated form, an array of scalars is its items joined with `, `, and an
 * embedded document is reached by a dotted path — the kit's language reads
 * `${author.name}` on its own. Bytes are **not** a document: a `Binary`
 * field is absent to a template, so a mapping that names one skips the
 * document as `missing_field` and says which. Files live in object stores,
 * and the s3 connector reads them; this one is for text.
 *
 * The driver sits behind a port so the source is driven against an array in
 * the suite and against a real MongoDB in the live run. BSON values are told
 * apart by `_bsontype`, the discriminator every value the `bson` library
 * makes carries, which is what lets this file name no driver type at all.
 */
import { createHash } from 'node:crypto'
import { ConfigError, type Fields, type Item, type Source } from '@nacre.work/connector-kit'

/** A document as the driver hands it over: plain keys, BSON values. */
export type Document = Readonly<Record<string, unknown>>

/** What the source needs of a collection, and all it needs. */
export interface Collection {
  /** Every document the filter matches, with the projection applied. A cursor that fails mid-way throws, which the engine reads as a listing that did not complete. */
  find(filter: Document, projection: Document | undefined): AsyncIterable<Document>
}

export interface MongoSourceOptions {
  readonly collection: Collection
  readonly filter: Document
  readonly projection: Document | undefined
  /** The field that is the identity, as a path into the document. */
  readonly id: readonly string[]
  /** The field that moves when the document does. Absent, the document's own hash. */
  readonly version: readonly string[] | undefined
}

export class MongoSource implements Source {
  constructor(private readonly o: MongoSourceOptions) {}

  async *list(): AsyncIterable<Item> {
    for await (const doc of this.o.collection.find(this.o.filter, this.o.projection)) {
      const fields = plain(doc) as Record<string, unknown>
      const id = scalar(at(fields, this.o.id))
      if (id === undefined) {
        // `_id` is always there — the projection is refused if it drops it —
        // so a document without its identity still has a name in the log.
        const detail = `MONGO_ID names ${this.o.id.join('.')}, which this document does not carry as a scalar`
        yield { id: `_id:${scalar(fields['_id']) ?? '?'}`, fields: { ...fields, skip: 'missing_field', skip_detail: detail } }
        continue
      }
      // The named field where the document carries it; its own hash where
      // it does not, so a document missing the field is still versioned
      // rather than mapped on every sweep.
      const named = this.o.version === undefined ? undefined : scalar(at(fields, this.o.version))
      const version = named ?? createHash('sha256').update(canonical(doc)).digest('hex')
      // `doc_id` is the connector's: the identity as rendered, which
      // `metadata.doc_id` and the default `external_id` read, and it shadows
      // a document field of that name.
      yield { id, version, fields: { ...fields, doc_id: id } }
    }
  }

  /** Nothing: the listing carried the whole document. */
  async fetch(): Promise<Fields> {
    return {}
  }
}

/** A value's rendering where it is one thing, and `undefined` where it is a document or an array of them. */
function scalar(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' ? String(value) : undefined
}

function at(fields: Record<string, unknown>, path: readonly string[]): unknown {
  let cur: unknown = fields
  for (const key of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

type BsonValue = { readonly _bsontype: string } & Record<string, unknown>

function bsonKind(value: object): string | undefined {
  const kind = (value as { _bsontype?: unknown })._bsontype
  return typeof kind === 'string' ? kind : undefined
}

/**
 * What a template sees of a BSON value. `undefined` is "not a field": bytes,
 * and the two sentinels (`MinKey`, `MaxKey`) that mean nothing outside a
 * query. A `null` stays `null`, which the kit reads as absent too.
 */
export function plain(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof RegExp) return value.source
  if (value instanceof Uint8Array) return undefined
  if (Array.isArray(value)) {
    const items = value.map(plain).filter((v) => v !== null && v !== undefined)
    return items.every((v) => typeof v !== 'object') ? items.map(String).join(', ') : items
  }
  const kind = bsonKind(value)
  if (kind !== undefined) return bson(kind, value as BsonValue)
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    const p = plain(v)
    if (p !== undefined) out[key] = p
  }
  return out
}

function bson(kind: string, value: BsonValue): unknown {
  switch (kind) {
    case 'ObjectId':
      return typeof value.toHexString === 'function' ? String((value.toHexString as () => string)()) : String(value)
    case 'Binary':
      // Subtype 4 is a UUID, which is an identity and not a file.
      return value.sub_type === 4 && typeof value.toUUID === 'function' ? String((value.toUUID as () => unknown)()) : undefined
    case 'Long':
    case 'Decimal128':
    case 'Int32':
    case 'Double':
    case 'Timestamp':
    case 'BSONSymbol':
      return String(value)
    case 'BSONRegExp':
      return typeof value.pattern === 'string' ? value.pattern : undefined
    case 'Code':
      return typeof value.code === 'string' ? value.code : undefined
    case 'DBRef':
      return `${String(value.collection)}/${String(plain(value.oid))}`
    default:
      return undefined
  }
}

/**
 * The document as a string that is the same for the same document: every
 * value as `plain` renders it, keys sorted at every depth, arrays kept as
 * arrays — joining would make `["a, b"]` and `["a", "b"]` one document.
 * Bytes count here, as base64, although a template cannot see them: a file
 * that changed is a document that changed.
 */
export function canonical(doc: unknown): string {
  return JSON.stringify(normalise(doc))
}

function normalise(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return String(value)
  if (typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof RegExp) return { $regex: value.source, $options: value.flags }
  if (value instanceof Uint8Array) return { $binary: Buffer.from(value).toString('base64') }
  if (Array.isArray(value)) return value.map(normalise)
  const kind = bsonKind(value)
  if (kind !== undefined) {
    const v = value as BsonValue
    if (kind === 'Binary' && v.buffer instanceof Uint8Array) return { $binary: Buffer.from(v.buffer).toString('base64'), $type: v.sub_type }
    return plain(value) ?? { $bson: kind }
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) out[key] = normalise((value as Record<string, unknown>)[key])
  return out
}

/** `MONGO_FILTER` and `MONGO_PROJECTION`: JSON, and a JSON object — not an array, not a scalar, not `null`. */
export function parseJsonObject(name: string, raw: string): Document {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new ConfigError(`${name} is not JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${name} is ${JSON.stringify(raw)}; it must be a JSON object such as {"kind":"handbook"}`)
  }
  return parsed as Document
}

/** A projection, which may not drop `_id`: a document with no identity cannot be named in the log, let alone removed. */
export function parseProjection(name: string, raw: string): Document {
  const projection = parseJsonObject(name, raw)
  const id = projection['_id']
  if (id === 0 || id === false) throw new ConfigError(`${name} excludes _id; every document needs its identity, so keep it in the projection`)
  return projection
}

/** `MONGO_ID` and `MONGO_VERSION`: a field, nested by dots, each segment non-empty. */
export function parsePath(name: string, raw: string): string[] {
  const path = raw.trim().split('.')
  if (path.some((segment) => segment === '')) throw new ConfigError(`${name} is ${JSON.stringify(raw)}; it must be a field name, nested by dots`)
  return path
}

const METADATA_KEY = /^[a-z][a-z0-9_]*$/

/** `MONGO_METADATA`: `key=template;key=template`, blanks dropped, keys as the index spells them. */
export function parseMetadata(name: string, spec: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of spec.split(';')) {
    const entry = part.trim()
    if (entry === '') continue
    const eq = entry.indexOf('=')
    if (eq <= 0) throw new ConfigError(`${name}: ${JSON.stringify(entry)} is not key=template`)
    const key = entry.slice(0, eq).trim()
    if (!METADATA_KEY.test(key)) throw new ConfigError(`${name}: key ${JSON.stringify(key)} must be lower-case letters, digits and underscores, starting with a letter`)
    out[key] = entry.slice(eq + 1).trim()
  }
  return out
}
