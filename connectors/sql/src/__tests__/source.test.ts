import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileMapping, State, sweep, type Index, type Mapped } from '@nacre.work/connector-kit'
import { describe, expect, it } from 'vitest'
import { driverFor, type Query, type Row } from '../db.js'
import { column, parseMetadata, rowHash, SqlSource } from '../source.js'

/** A table in an array: the listing is its rows, in order, and the suite edits it between sweeps. */
class MemoryQuery implements Query {
  rows_: Row[] = []
  /** Throw after this many rows, as a connection dropping mid-result would. */
  failAfter: number | undefined
  async *rows(): AsyncIterable<Row> {
    let n = 0
    for (const row of this.rows_) {
      if (this.failAfter !== undefined && n === this.failAfter) throw new Error('connection reset by peer')
      n += 1
      yield row
    }
  }
  set(id: number, patch: Partial<Record<string, unknown>>) {
    this.rows_ = this.rows_.map((r) => (r['id'] === id ? { ...r, ...patch } : r))
  }
  delete(id: number) {
    this.rows_ = this.rows_.filter((r) => r['id'] !== id)
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

// The connector's own default mapping, as main.ts builds it for SQL_ID=id.
const mapping = compileMapping({
  layer: '${kind}',
  externalId: '${id}',
  title: '${title}',
  content: '${content}',
  metadata: { row_id: '${id}', tag: '${tag|none}', when: '${updated_at|}' },
})
// The same mapping without the watermark in it: a watermark rendered into a
// document is part of the document, and moving it is then a change the hash
// is right to see — so the case about skipping the hash must not render it.
const plain = compileMapping({ layer: '${kind}', externalId: '${id}', title: '${title}', content: '${content}', metadata: { row_id: '${id}' } })
const quiet = { skipped: () => undefined, failed: () => undefined }
const provenance = { connector: 'sql', source: 'memory' }
const T1 = new Date('2026-01-01T00:00:00Z')
const T2 = new Date('2026-02-01T00:00:00Z')

function table(): MemoryQuery {
  const q = new MemoryQuery()
  q.rows_ = [
    { id: 1, kind: 'handbook', title: 'leave.md', content: '# Leave\n\nalphaleave', tag: 'hr', updated_at: T1 },
    { id: 2, kind: 'code', title: 'a.ts', content: 'export const codeword = "betacode"', tag: null, updated_at: T1 },
  ]
  return q
}
function state() {
  return new State(join(mkdtempSync(join(tmpdir(), 'sql-')), 'state.sqlite'))
}
function source(query: Query, versionColumn?: string) {
  return new SqlSource({ query, idColumn: 'id', versionColumn })
}
function recorder() {
  const skipped: string[] = []
  return { skipped, report: { skipped: (reason: string, item: string, detail: string) => void skipped.push(`${reason}:${item}:${detail}`), failed: () => undefined } }
}

describe('the three verbs over a query', () => {
  it('adds every row, versions it by its hash, sees a changed cell, and removes a row the result lost', async () => {
    const q = table()
    const index = new FakeIndex()
    const st = state()

    const first = await sweep({ source: source(q), mapping, index, state: st, provenance, report: quiet })
    expect(first).toMatchObject({ complete: true, listed: 2, added: 2, skipped: {} })
    const byId = Object.fromEntries(index.adds.map((d) => [d.externalId, d]))
    expect(byId['1']).toMatchObject({
      layer: 'handbook',
      title: 'leave.md',
      content: '# Leave\n\nalphaleave',
      // Every document names its row; a date renders as ISO 8601; a NULL renders its default.
      metadata: { connector: 'sql', source: 'memory', row_id: '1', tag: 'hr', when: '2026-01-01T00:00:00.000Z' },
    })
    expect(byId['2']).toMatchObject({ layer: 'code', metadata: { row_id: '2', tag: 'none' } })

    // Nothing moved: every row is remembered by its hash and none is re-sent.
    const second = await sweep({ source: source(q), mapping, index, state: st, provenance, report: quiet })
    expect(second).toMatchObject({ added: 0, changed: 0, unchanged: 2, removed: 0 })
    expect(index.adds).toHaveLength(2)

    // One cell changes — the watermark does not — and the row hash sees it.
    q.set(1, { content: '# Leave\n\ngammaleave' })
    q.delete(2)
    const third = await sweep({ source: source(q), mapping, index, state: st, provenance, report: quiet })
    expect(third).toMatchObject({ changed: 1, removed: 1, unchanged: 0 })
    expect(index.adds.at(-1)).toMatchObject({ externalId: '1', content: '# Leave\n\ngammaleave' })
    expect(index.removes).toEqual(['doc-2'])
  })

  it('with a watermark, an unchanged watermark skips the hash, and a moved one with the same content is not re-added', async () => {
    const q = table()
    const index = new FakeIndex()
    const st = state()
    await sweep({ source: source(q, 'updated_at'), mapping: plain, index, state: st, provenance, report: quiet })
    expect(index.adds).toHaveLength(2)

    // The cheap path: a cell edited without the watermark moving is not seen —
    // which is what proves the hash was skipped, and is the contract an
    // updated_at column already makes with everything that reads it.
    q.set(1, { content: 'edited without touching the watermark' })
    const second = await sweep({ source: source(q, 'updated_at'), mapping: plain, index, state: st, provenance, report: quiet })
    expect(second).toMatchObject({ unchanged: 2, changed: 0 })
    expect(index.adds).toHaveLength(2)

    // The watermark moves and the content is what the index already has:
    // hashed again, found equal, nothing sent.
    q.set(1, { content: '# Leave\n\nalphaleave', updated_at: T2 })
    const third = await sweep({ source: source(q, 'updated_at'), mapping: plain, index, state: st, provenance, report: quiet })
    expect(third).toMatchObject({ unchanged: 2, changed: 0 })
    expect(index.adds).toHaveLength(2)

    // The watermark moves with the content: a change.
    q.set(1, { content: '# Leave\n\ngammaleave', updated_at: new Date('2026-03-01T00:00:00Z') })
    const fourth = await sweep({ source: source(q, 'updated_at'), mapping: plain, index, state: st, provenance, report: quiet })
    expect(fourth).toMatchObject({ changed: 1, unchanged: 1 })
    expect(index.adds.at(-1)?.content).toBe('# Leave\n\ngammaleave')
  })

  it('a statement that fails halfway removes nothing', async () => {
    const q = table()
    const index = new FakeIndex()
    const st = state()
    await sweep({ source: source(q), mapping, index, state: st, provenance, report: quiet })

    q.failAfter = 1
    const broken = await sweep({ source: source(q), mapping, index, state: st, provenance, report: quiet })
    expect(broken).toMatchObject({ complete: false, listed: 1, removed: 0, error: 'connection reset by peer' })
    expect(index.removes).toEqual([])

    // The next complete result is what decides.
    q.failAfter = undefined
    q.delete(2)
    const clean = await sweep({ source: source(q), mapping, index, state: st, provenance, report: quiet })
    expect(clean).toMatchObject({ complete: true, removed: 1 })
    expect(index.removes).toEqual(['doc-2'])
  })

  it('a NULL is an absent field: a default renders it, and a column with none skips the row', async () => {
    const q = new MemoryQuery()
    q.rows_ = [
      { id: 1, kind: 'handbook', title: 'a', content: null, tag: null },
      { id: 2, kind: 'handbook', title: null, content: 'untitled', tag: null },
    ]
    const index = new FakeIndex()
    const { skipped, report } = recorder()
    const r = await sweep({ source: source(q), mapping, index, state: state(), provenance, report })
    expect(r).toMatchObject({ added: 1, skipped: { missing_field: 1 } })
    expect(skipped).toEqual(['missing_field:1:content'])
    // The default title is the title column, and the identity where it is NULL.
    expect(index.adds[0]).toMatchObject({ externalId: '2', title: '2', metadata: { tag: 'none' } })
  })

  it('the title falls back to the identity where the statement returns no title column', async () => {
    const q = new MemoryQuery()
    q.rows_ = [{ id: 7, kind: 'handbook', content: 'no title column at all' }]
    const index = new FakeIndex()
    await sweep({ source: source(q), mapping, index, state: state(), provenance, report: quiet })
    expect(index.adds[0]?.title).toBe('7')
  })

  it('a row holding bytes is skipped as binary, naming the column, and a row too large as oversize', async () => {
    const q = new MemoryQuery()
    q.rows_ = [
      { id: 1, kind: 'handbook', title: 'scan', content: 'text beside a blob', attachment: new Uint8Array([0xff, 0xd8, 0xff]) },
      { id: 2, kind: 'handbook', title: 'big', content: 'x'.repeat(4096) },
      { id: 3, kind: 'handbook', title: 'fine', content: 'fits' },
    ]
    const index = new FakeIndex()
    const { skipped, report } = recorder()
    const r = await sweep({ source: source(q), mapping, index, state: state(), provenance, report, maxBytes: 1024 })
    expect(r).toMatchObject({ added: 1, skipped: { binary: 1, oversize: 1 } })
    expect(skipped).toEqual(['binary:1:column "attachment" holds bytes; a row is text only', 'oversize:2:4096 bytes'])
    expect(index.adds.map((d) => d.externalId)).toEqual(['3'])
  })

  it('refuses, by name, a result without the identity column, a NULL identity, and a watermark column the result lacks', async () => {
    const q = new MemoryQuery()
    const index = new FakeIndex()
    q.rows_ = [{ doc_id: 1, kind: 'handbook', content: 'x' }]
    let r = await sweep({ source: source(q), mapping, index, state: state(), provenance, report: quiet })
    expect(r.complete).toBe(false)
    expect(r.error).toContain('SQL_ID names "id"')

    q.rows_ = [{ id: null, kind: 'handbook', content: 'x' }]
    r = await sweep({ source: source(q), mapping, index, state: state(), provenance, report: quiet })
    expect(r.error).toContain('NULL in "id"')

    q.rows_ = [{ id: 1, kind: 'handbook', content: 'x' }]
    r = await sweep({ source: source(q, 'updated_at'), mapping, index, state: state(), provenance, report: quiet })
    expect(r.error).toContain('SQL_VERSION names "updated_at"')
    expect(index.adds).toEqual([])

    // A NULL watermark says nothing about the row, so that row is hashed.
    q.rows_ = [{ id: 1, kind: 'handbook', content: 'x', updated_at: null }]
    r = await sweep({ source: source(q, 'updated_at'), mapping, index, state: state(), provenance, report: quiet })
    expect(r).toMatchObject({ complete: true, added: 1 })
  })
})

describe('the row hash', () => {
  it('is over the row in canonical key order, so the column order a driver hands back does not move the version', () => {
    expect(rowHash({ b: 2, a: { y: null, x: [1, 'two'] } })).toBe(rowHash({ a: { x: [1, 'two'], y: null }, b: 2 }))
    expect(rowHash({ a: 1 })).not.toBe(rowHash({ a: '1' }))
  })
})

describe('the configuration', () => {
  it('names a driver for the four schemes and refuses any other by name, before anything connects', () => {
    expect(driverFor('postgres://u:p@db:5432/app')).toBe('postgres')
    expect(driverFor('postgresql://u:p@db/app?sslmode=require')).toBe('postgres')
    expect(driverFor('mysql://u:p@db:3306/app')).toBe('mysql')
    expect(driverFor('mariadb://u:p@db/app')).toBe('mysql')
    expect(() => driverFor('sqlite:///tmp/app.db')).toThrow(/SQL_URL has the scheme sqlite:\/\/.*postgres:\/\/, postgresql:\/\/, mysql:\/\/ or mariadb:\/\//)
    expect(() => driverFor('db:5432')).toThrow(/SQL_URL has the scheme db:\/\//)
    expect(() => driverFor('not a url')).toThrow(/SQL_URL is not a URL/)
  })

  it('holds a column name to what a template can reference', () => {
    expect(column('SQL_ID', 'doc_id')).toBe('doc_id')
    expect(() => column('SQL_ID', 'DocID')).toThrow(/SQL_ID is "DocID".*alias it in SQL_QUERY/)
    expect(() => column('SQL_VERSION', 'updated at')).toThrow(/SQL_VERSION/)
  })

  it('parses key=template pairs and refuses a malformed one by the variable', () => {
    expect(parseMetadata('', 'SQL_METADATA')).toEqual({})
    expect(parseMetadata('source_table=documents; owner=${owner|nobody}', 'SQL_METADATA')).toEqual({ source_table: 'documents', owner: '${owner|nobody}' })
    expect(() => parseMetadata('owner', 'SQL_METADATA')).toThrow(/SQL_METADATA: "owner" is not key=template/)
    expect(() => parseMetadata('Owner=${owner}', 'SQL_METADATA')).toThrow(/SQL_METADATA: "Owner" is not a metadata key/)
  })
})
