/**
 * A query as a source. The listing is every row one statement returns, a row
 * is a document, and a row absent from a **complete** result is a document
 * that leaves the index — which is the engine's rule and not this file's: a
 * statement that fails halfway removes nothing, because the rows it never
 * reached have not been called gone.
 *
 * A row's **version** is where this source differs from a tree or a bucket.
 * Neither offers a cheap version by itself, so there are two, and the
 * operator picks. A watermark column — an `updated_at`, a version number —
 * is the cheap path the engine was built for: an unchanged watermark skips
 * the hash and the comparison, and the cost is that a row edited without its
 * watermark moving is not re-sent, which is the contract such a column
 * already makes with everything else that reads it. Without one, the version
 * is a hash over the whole row, in canonical key order, computed here in the
 * listing — the row is already in memory, the statement returned it — so a
 * changed cell anywhere in the row is a changed version, and `fetch` has
 * nothing left to do: every field the mapping reads was in the listing.
 *
 * Text rows only. A column holding bytes — `bytea`, a `BLOB` — makes the row
 * a `binary` skip naming the column, because a file in a row has no name and
 * no type the index could be told, and files live in object stores. Dates
 * arrive as ISO 8601 text; `NULL` is an absent field, so a template reading
 * it renders its `|default` or skips the row as `missing_field`.
 *
 * The database is behind a port so the source is driven against an array in
 * the suite and against a real Postgres in the live run; the drivers sit on
 * the other side of that port and nowhere else.
 */
import { createHash } from 'node:crypto'
import { ConfigError, type Fields, type Item, type Source } from '@nacre.work/connector-kit'
import type { Query, Row } from './db.js'

/**
 * A column is a field, and a template references a field by this grammar —
 * so an id or watermark column spelled otherwise could never be read by one.
 * Postgres folds an unquoted identifier to lower case; anything else is
 * aliased in the statement (`SELECT "DocID" AS doc_id`).
 */
const COLUMN = /^[a-z_][a-z0-9_]*$/

export function column(name: string, value: string): string {
  if (!COLUMN.test(value)) {
    throw new ConfigError(`${name} is ${JSON.stringify(value)}; a column name here is lower-case letters, digits and underscores, so alias it in SQL_QUERY`)
  }
  return value
}

/** `key=template;key=template`; a key is what a metadata key may be, and the template is over the row's columns. */
export function parseMetadata(spec: string, name: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of spec.split(';')) {
    const entry = part.trim()
    if (entry === '') continue
    const eq = entry.indexOf('=')
    if (eq <= 0) throw new ConfigError(`${name}: ${JSON.stringify(entry)} is not key=template`)
    const key = entry.slice(0, eq).trim()
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new ConfigError(`${name}: ${JSON.stringify(key)} is not a metadata key; one is lower-case letters, digits and underscores`)
    out[key] = entry.slice(eq + 1).trim()
  }
  return out
}

export interface SqlSourceOptions {
  readonly query: Query
  /** The column that is a row's identity; its value is `Item.id`. */
  readonly idColumn: string
  /** A watermark column. Absent, a row's version is a hash over all of it. */
  readonly versionColumn: string | undefined
}

export class SqlSource implements Source {
  constructor(private readonly o: SqlSourceOptions) {}

  async *list(): AsyncIterable<Item> {
    const { idColumn, versionColumn } = this.o
    for await (const row of this.o.query.rows()) {
      // A row without an identity cannot be synced, and a statement that
      // returns one is a statement to fix: the listing fails, by name, and
      // removes nothing — rather than one row quietly never arriving.
      if (!(idColumn in row)) throw new Error(`SQL_ID names ${JSON.stringify(idColumn)}, and SQL_QUERY returns no such column`)
      if (versionColumn !== undefined && !(versionColumn in row)) {
        throw new Error(`SQL_VERSION names ${JSON.stringify(versionColumn)}, and SQL_QUERY returns no such column`)
      }
      const { fields, binary } = rowFields(row)
      const id = fields[idColumn]
      if (id === undefined || id === null) throw new Error(`a row has NULL in ${JSON.stringify(idColumn)}, which SQL_ID names as the identity`)
      if (binary === idColumn) throw new Error(`${JSON.stringify(idColumn)} holds bytes, and SQL_ID names it as the identity`)
      const itemId = text(id)
      // A watermark that is NULL says nothing about the row, so that row is
      // versioned the way every row is without one.
      const watermark = versionColumn === undefined ? undefined : fields[versionColumn]
      const version = watermark === undefined || watermark === null ? rowHash(fields) : text(watermark)
      // The default title is the `title` column, and the identity where the
      // statement returns no such column or the row's is NULL — so a table
      // with no title has titles rather than skipped rows.
      if (fields['title'] === undefined || fields['title'] === null) fields['title'] = itemId
      if (binary !== undefined) {
        yield { id: itemId, version, fields: { ...fields, skip: 'binary', skip_detail: `column ${JSON.stringify(binary)} holds bytes; a row is text only` } }
        continue
      }
      yield { id: itemId, version, fields }
    }
  }

  /** The listing carried every field; there is nothing left to read. */
  async fetch(): Promise<Fields> {
    return {}
  }
}

/**
 * A row as a template sees it: every column by name, a `Date` as ISO 8601
 * text, a `bigint` as text, bytes replaced by their digest and the column
 * named so the row can be refused — a digest rather than the bytes, so the
 * row's hash follows a changed blob without the blob reaching a template.
 */
function rowFields(row: Row): { fields: Record<string, unknown>; binary: string | undefined } {
  const fields: Record<string, unknown> = {}
  let binary: string | undefined
  for (const [name, value] of Object.entries(row)) {
    if (value instanceof Uint8Array) {
      binary ??= name
      fields[name] = createHash('sha256').update(value).digest('hex')
      continue
    }
    fields[name] = convert(value)
  }
  return { fields, binary }
}

function convert(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  return value
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'object' && value !== null ? canonical(value) : String(value)
}

/** sha256 over the row's fields as canonical JSON: keys sorted at every level, so two reads of one row agree whatever order the driver handed the columns in. */
export function rowHash(fields: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonical(fields)).digest('hex')
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return value === undefined ? 'null' : JSON.stringify(value)
}
