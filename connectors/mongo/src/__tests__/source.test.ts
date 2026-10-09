import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileMapping, ConfigError, State, sweep, type Index, type Item, type Mapped } from '@nacre.work/connector-kit'
import { BSON, ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { parseUrl } from '../driver.js'
import { canonical, MongoSource, parseJsonObject, parseMetadata, parsePath, parseProjection, plain, type Collection, type Document } from '../source.js'

/**
 * A collection in an array: the listing is its documents, a filter is matched
 * on top-level equality — enough to show a document edited out of the filter
 * leaving — and the suite edits it between sweeps. `failAfter` breaks the
 * cursor part-way, which is how a replica set election or a dropped
 * connection arrives.
 */
class MemoryCollection implements Collection {
  readonly docs: Record<string, unknown>[] = []
  failAfter: number | undefined
  put(doc: Record<string, unknown>) {
    const i = this.docs.findIndex((d) => String(d['_id']) === String(doc['_id']))
    if (i === -1) this.docs.push(doc)
    else this.docs[i] = doc
  }
  delete(id: unknown) {
    const i = this.docs.findIndex((d) => String(d['_id']) === String(id))
    if (i !== -1) this.docs.splice(i, 1)
  }
  async *find(filter: Document): AsyncIterable<Document> {
    let n = 0
    for (const doc of this.docs) {
      if (!Object.entries(filter).every(([k, v]) => doc[k] === v)) continue
      if (this.failAfter !== undefined && n === this.failAfter) throw new Error('connection reset by peer')
      n += 1
      yield doc
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

const mapping = compileMapping({
  layer: '${kind}',
  externalId: '${doc_id}',
  title: '${title}',
  content: '${body}',
  metadata: { doc_id: '${doc_id}', author: '${author.name|}', tags: '${tags|}' },
})
const quiet = { skipped: () => undefined, failed: () => undefined }
const provenance = { connector: 'mongo', source: 'memory' }

function source(collection: Collection, o: { filter?: Document; id?: string[]; version?: string[] } = {}) {
  const inner = new MongoSource({ collection, filter: o.filter ?? {}, projection: undefined, id: o.id ?? ['_id'], version: o.version })
  // The engine skips `fetch` on the cheap path, so counting fetches is what
  // says a document that did not move was never mapped.
  const fetches: string[] = []
  return {
    fetches,
    list: () => inner.list(),
    fetch: (item: Item) => {
      fetches.push(item.id)
      return inner.fetch()
    },
  }
}

function state() {
  return new State(join(mkdtempSync(join(tmpdir(), 'mongo-')), 'state.sqlite'))
}

const LEAVE = new ObjectId('507f1f77bcf86cd799439011')
const CODE = new ObjectId('507f1f77bcf86cd799439012')

describe('the three verbs over a collection', () => {
  it('maps a document from its fields, versions it by its own hash, skips what it cannot send, and removes what left', async () => {
    const docs = new MemoryCollection()
    docs.put({ _id: LEAVE, kind: 'handbook', title: 'leave.md', body: '# Leave\n\nalphaleave', author: { name: 'Dana' }, tags: ['hr', 'policy'] })
    docs.put({ _id: CODE, kind: 'code', title: 'a.ts', body: 'export const a = 1' })
    docs.put({ _id: new ObjectId(), kind: 'code', title: 'big.ts', body: 'x'.repeat(4096) })
    docs.put({ _id: new ObjectId(), kind: 'code', title: 'empty.ts', body: '' })
    docs.put({ _id: new ObjectId(), kind: 'handbook', title: 'scan.pdf', body: new BSON.Binary(Buffer.from('%PDF-1.4')) })
    docs.put({ _id: new ObjectId(), kind: 'draft', title: 'draft.md', body: 'outside the filter' })
    const index = new FakeIndex()
    const st = state()
    const skipped: string[] = []
    const report = { skipped: (reason: string, item: string, detail: string) => void skipped.push(`${reason}:${item}:${detail}`), failed: () => undefined }
    const filter = {}
    const s = source(docs, { filter })

    const first = await sweep({ source: s, mapping, index, state: st, provenance, report, maxBytes: 1024 })
    expect(first).toMatchObject({ complete: true, listed: 6, added: 3, skipped: { oversize: 1, empty: 1, missing_field: 1 } })
    // Bytes are not a document: the field is absent, and the skip names it.
    expect(skipped.find((l) => l.startsWith('missing_field'))).toMatch(/^missing_field:[0-9a-f]{24}:body$/)

    const byId = Object.fromEntries(index.adds.map((d) => [d.externalId, d]))
    const leave = byId[LEAVE.toHexString()]
    expect(leave).toMatchObject({ layer: 'handbook', title: 'leave.md', content: '# Leave\n\nalphaleave' })
    // Nested by a dotted path, an ObjectId as hex, an array of scalars joined.
    expect(leave?.metadata).toMatchObject({ doc_id: LEAVE.toHexString(), author: 'Dana', tags: 'hr, policy' })
    expect(byId[CODE.toHexString()]).toMatchObject({ layer: 'code', metadata: { author: '', tags: '' } })

    // Nothing moved: nothing fetched, nothing mapped, nothing sent — the
    // document hash computed in the listing is the version the state holds.
    s.fetches.length = 0
    const second = await sweep({ source: s, mapping, index, state: st, provenance, report: quiet, maxBytes: 1024 })
    expect(second).toMatchObject({ added: 0, changed: 0, unchanged: 3, skipped: { oversize: 1, empty: 1, missing_field: 1 } })
    expect(s.fetches).toEqual([])
    expect(index.adds).toHaveLength(3)

    // A field a template never reads still moves the version, so the
    // document is mapped again — and then not sent, because what the index
    // would be sent is the same. The fetch says the hash saw the field; the
    // count says the index did not pay for it.
    docs.put({ _id: LEAVE, kind: 'handbook', title: 'leave.md', body: '# Leave\n\nalphaleave', author: { name: 'Dana' }, tags: ['hr', 'policy'], reviewed: true })
    const third = await sweep({ source: s, mapping, index, state: st, provenance, report: quiet, maxBytes: 1024 })
    expect(third).toMatchObject({ changed: 0, unchanged: 3 })
    expect(s.fetches).toEqual([LEAVE.toHexString()])
    expect(index.adds).toHaveLength(3)

    // A change to the text, and a removal; and a document edited out of the
    // filter leaves the same way as one deleted.
    docs.put({ _id: LEAVE, kind: 'handbook', title: 'leave.md', body: '# Leave\n\ngammaleave', author: { name: 'Dana' }, tags: ['hr', 'policy'], reviewed: true })
    docs.delete(CODE)
    const fourth = await sweep({ source: s, mapping, index, state: st, provenance, report: quiet, maxBytes: 1024 })
    expect(fourth).toMatchObject({ changed: 1, removed: 1, unchanged: 1 })
    expect(index.adds.at(-1)?.content).toBe('# Leave\n\ngammaleave')
    expect(index.removes).toHaveLength(1)
  })

  it('believes a version field: an edit that did not move it is not seen, and one that did is', async () => {
    const docs = new MemoryCollection()
    docs.put({ _id: LEAVE, kind: 'handbook', title: 'leave.md', body: 'one', rev: 1 })
    docs.put({ _id: CODE, kind: 'code', title: 'a.ts', body: 'a', updated: new Date('2026-01-01T00:00:00Z') })
    const index = new FakeIndex()
    const st = state()
    const s = source(docs, { version: ['rev'] })

    await sweep({ source: s, mapping, index, state: st, provenance, report: quiet })
    expect(index.adds).toHaveLength(2)

    // The body moved and `rev` did not: the version is the deployment's
    // claim, and the connector takes it at its word rather than re-hashing.
    docs.put({ _id: LEAVE, kind: 'handbook', title: 'leave.md', body: 'two', rev: 1 })
    s.fetches.length = 0
    const second = await sweep({ source: s, mapping, index, state: st, provenance, report: quiet })
    expect(second).toMatchObject({ changed: 0, unchanged: 2 })
    expect(s.fetches).toEqual([])

    docs.put({ _id: LEAVE, kind: 'handbook', title: 'leave.md', body: 'two', rev: 2 })
    const third = await sweep({ source: s, mapping, index, state: st, provenance, report: quiet })
    expect(third).toMatchObject({ changed: 1, unchanged: 1 })
    expect(index.adds.at(-1)?.content).toBe('two')

    // A document without the field falls back to its hash, so an edit to it
    // is still seen.
    docs.put({ _id: CODE, kind: 'code', title: 'a.ts', body: 'b', updated: new Date('2026-01-01T00:00:00Z') })
    const fourth = await sweep({ source: s, mapping, index, state: st, provenance, report: quiet })
    expect(fourth).toMatchObject({ changed: 1, unchanged: 1 })
  })

  it('removes nothing when the cursor breaks part-way', async () => {
    const docs = new MemoryCollection()
    docs.put({ _id: LEAVE, kind: 'handbook', title: 'leave.md', body: 'one' })
    docs.put({ _id: CODE, kind: 'code', title: 'a.ts', body: 'a' })
    docs.put({ _id: new ObjectId(), kind: 'code', title: 'b.ts', body: 'b' })
    const index = new FakeIndex()
    const st = state()
    const s = source(docs)
    await sweep({ source: s, mapping, index, state: st, provenance, report: quiet })

    // One document gone, and the cursor dies after the first of the two
    // that remain: the half never reached has not been called gone.
    docs.delete(CODE)
    docs.failAfter = 1
    const broken = await sweep({ source: s, mapping, index, state: st, provenance, report: quiet })
    expect(broken).toMatchObject({ complete: false, removed: 0, error: 'connection reset by peer' })
    expect(index.removes).toEqual([])

    docs.failAfter = undefined
    const whole = await sweep({ source: s, mapping, index, state: st, provenance, report: quiet })
    expect(whole).toMatchObject({ complete: true, removed: 1 })
  })

  it('takes the identity from the named field and skips a document that lacks it', async () => {
    const docs = new MemoryCollection()
    docs.put({ _id: LEAVE, kind: 'handbook', title: 'leave.md', body: 'one', slug: 'people/leave' })
    docs.put({ _id: CODE, kind: 'code', title: 'a.ts', body: 'a' })
    const items: Item[] = []
    for await (const item of source(docs, { id: ['slug'] }).list()) items.push(item)
    expect(items.map((i) => i.id)).toEqual(['people/leave', `_id:${CODE.toHexString()}`])
    expect(items[0]?.fields['doc_id']).toBe('people/leave')
    expect(items[1]?.fields).toMatchObject({ skip: 'missing_field', skip_detail: 'MONGO_ID names slug, which this document does not carry as a scalar' })
  })
})

describe('what a template sees of a BSON value', () => {
  const oid = new ObjectId('507f1f77bcf86cd799439011')
  const doc = {
    _id: oid,
    when: new Date('2026-03-04T05:06:07.089Z'),
    big: BSON.Long.fromString('9007199254740993'),
    price: BSON.Decimal128.fromString('1.50'),
    key: new BSON.UUID('5a3a8502-2b53-4231-874c-4901c8f432bb'),
    file: new BSON.Binary(Buffer.from('bytes')),
    tags: ['a', 2, true, null],
    rows: [{ n: 1 }, { n: 2 }],
    nested: { deep: { oid } },
    none: null,
  }

  it('renders ids, dates, numbers and arrays as text and leaves bytes out', () => {
    expect(plain(doc)).toEqual({
      _id: '507f1f77bcf86cd799439011',
      when: '2026-03-04T05:06:07.089Z',
      big: '9007199254740993',
      price: '1.50',
      key: '5a3a8502-2b53-4231-874c-4901c8f432bb',
      tags: 'a, 2, true',
      rows: [{ n: 1 }, { n: 2 }],
      nested: { deep: { oid: '507f1f77bcf86cd799439011' } },
      none: null,
    })
  })

  it('hashes the same document to the same string whatever the key order, and bytes count', () => {
    const a = canonical({ x: 1, y: { b: 2, a: [1, { d: 4, c: 3 }] }, f: new BSON.Binary(Buffer.from('one')) })
    const b = canonical({ y: { a: [1, { c: 3, d: 4 }], b: 2 }, f: new BSON.Binary(Buffer.from('one')), x: 1 })
    const c = canonical({ y: { a: [1, { c: 3, d: 4 }], b: 2 }, f: new BSON.Binary(Buffer.from('two')), x: 1 })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(canonical({ tags: ['a, b'] })).not.toBe(canonical({ tags: ['a', 'b'] }))
  })
})

describe('the variables, refused by name', () => {
  it('reads a filter and a projection as JSON objects and nothing else', () => {
    expect(parseJsonObject('MONGO_FILTER', '{"kind":"handbook"}')).toEqual({ kind: 'handbook' })
    expect(() => parseJsonObject('MONGO_FILTER', '{kind: handbook}')).toThrow(/^MONGO_FILTER is not JSON/)
    expect(() => parseJsonObject('MONGO_FILTER', '[1]')).toThrow(/^MONGO_FILTER is "\[1\]"; it must be a JSON object/)
    expect(() => parseJsonObject('MONGO_FILTER', 'null')).toThrow(ConfigError)
    expect(parseProjection('MONGO_PROJECTION', '{"title":1,"body":1}')).toEqual({ title: 1, body: 1 })
    expect(() => parseProjection('MONGO_PROJECTION', '{"title":1,"_id":0}')).toThrow(/^MONGO_PROJECTION excludes _id/)
  })

  it('reads a field path and a metadata spec', () => {
    expect(parsePath('MONGO_VERSION', 'meta.updatedAt')).toEqual(['meta', 'updatedAt'])
    expect(() => parsePath('MONGO_ID', 'a..b')).toThrow(/^MONGO_ID is "a\.\.b"/)
    expect(parseMetadata('MONGO_METADATA', 'kind=${kind}; owner=${author.name|nobody}')).toEqual({ kind: '${kind}', owner: '${author.name|nobody}' })
    expect(() => parseMetadata('MONGO_METADATA', 'kind')).toThrow(/^MONGO_METADATA: "kind" is not key=template/)
    expect(() => parseMetadata('MONGO_METADATA', 'Kind=${kind}')).toThrow(/^MONGO_METADATA: key "Kind"/)
  })

  it('reads the connection string by its own grammar, so a replica set with a credential is shown without it', () => {
    expect(parseUrl('mongodb://user:p%40ss@h1:27017,h2:27017/corp?replicaSet=rs&authSource=admin')).toEqual({ origin: 'mongodb://h1:27017,h2:27017', database: 'corp' })
    expect(parseUrl('mongodb+srv://user:pw@cluster0.example.net/corp%20docs?retryWrites=true')).toEqual({ origin: 'mongodb+srv://cluster0.example.net', database: 'corp docs' })
    expect(parseUrl('mongodb://localhost:27017')).toEqual({ origin: 'mongodb://localhost:27017', database: undefined })
    expect(parseUrl('mongodb://localhost:27017/?w=1')).toEqual({ origin: 'mongodb://localhost:27017', database: undefined })
    expect(() => parseUrl('postgres://localhost/db')).toThrow(/mongodb:\/\//)
    expect(() => parseUrl('mongodb://')).toThrow()
  })
})
