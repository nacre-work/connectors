import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileMapping, parseLayerRules, State, sweep, type Index, type Mapped } from '@nacre.work/connector-kit'
import { describe, expect, it } from 'vitest'
import { S3Source, type ObjectStore, type StoredObject } from '../source.js'

/** A bucket in a map: the listing is its keys, a get counts, and the suite edits it between sweeps. */
class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>()
  readonly gets: string[] = []
  put(key: string, body: string | Uint8Array, contentType?: string) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
    this.objects.set(key, contentType === undefined ? { bytes } : { bytes, contentType })
  }
  async *list(prefix: string): AsyncIterable<StoredObject> {
    for (const [key, o] of this.objects) {
      if (!key.startsWith(prefix)) continue
      // An ETag the way a store computes one: over the bytes, so an identical put keeps it.
      const etag = Array.from(o.bytes).reduce((h, b) => (h * 31 + b) % 1_000_003, 7).toString(16)
      yield { key, etag, size: o.bytes.byteLength, lastModified: new Date('2026-01-01T00:00:00Z') }
    }
  }
  async get(key: string) {
    this.gets.push(key)
    const o = this.objects.get(key)
    if (o === undefined) throw new Error(`no such key ${key}`)
    return { bytes: o.bytes, contentType: o.contentType }
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

const mapping = compileMapping({ layer: '${layer}', externalId: '${path}', title: '${name}', content: '${content}', metadata: { key: '${key}' } })
const quiet = { skipped: () => undefined, failed: () => undefined }
const provenance = { connector: 's3', source: 'memory' }
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function source(store: ObjectStore, prefix = 'corp/') {
  return new S3Source({
    store,
    prefix,
    include: ['**'],
    exclude: ['**/*.tmp'],
    rules: parseLayerRules('docs/**=handbook;src/**=code', 'S3_LAYERS'),
    maxBytes: 1024,
  })
}

describe('the three verbs over a bucket', () => {
  it('lists under the prefix, reads text as text and files as bytes, skips what it cannot read, and removes what left', async () => {
    const store = new MemoryStore()
    store.put('corp/docs/leave.md', '# Leave\n\nalphaleave')
    store.put('corp/docs/budget.docx', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 'application/octet-stream')
    store.put('corp/docs/scan.bin', new Uint8Array([0xff, 0xfe, 0x00, 0x01]), 'application/octet-stream')
    store.put('corp/docs/memo', new Uint8Array([0x7b, 0x5c, 0x72, 0x74, 0x66, 0x31]), 'text/rtf')
    store.put('corp/src/a.ts', 'export const a = 1')
    store.put('corp/src/big.ts', 'x'.repeat(4096))
    store.put('corp/notes.txt', 'unmapped')
    store.put('corp/docs/draft.tmp', 'excluded')
    store.put('corp/docs/', '')
    store.put('other/docs/else.md', 'outside the prefix')
    const index = new FakeIndex()
    const state = new State(join(mkdtempSync(join(tmpdir(), 's3-')), 'state.sqlite'))
    const skipped: string[] = []
    const report = { skipped: (reason: string, item: string) => void skipped.push(`${reason}:${item}`), failed: () => undefined }

    const first = await sweep({ source: source(store), mapping, index, state, provenance, report })
    expect(first).toMatchObject({ complete: true, added: 4, skipped: { unmapped: 1, oversize: 1, binary: 1 } })
    expect(skipped.sort()).toEqual(['binary:corp/docs/scan.bin', 'oversize:corp/src/big.ts', 'unmapped:corp/notes.txt'])
    // The oversize object was never downloaded: the listing said its size.
    expect(store.gets).not.toContain('corp/src/big.ts')

    const byId = Object.fromEntries(index.adds.map((d) => [d.externalId, d]))
    expect(byId['docs/leave.md']).toMatchObject({ layer: 'handbook', content: '# Leave\n\nalphaleave', metadata: { key: 'corp/docs/leave.md' } })
    expect(byId['src/a.ts']?.layer).toBe('code')
    // By extension: the type the index must be told, whatever the store said.
    expect(byId['docs/budget.docx']).toMatchObject({ contentType: DOCX, content: undefined })
    expect(byId['docs/budget.docx']?.bytes).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))
    // By the object's own type, where the key has no telling extension — and
    // canonical, so the alias the store wrote is sent as the row it names.
    expect(byId['docs/memo']?.contentType).toBe('application/rtf')

    // Unchanged ETags: nothing downloaded on the second sweep.
    store.gets.length = 0
    const second = await sweep({ source: source(store), mapping, index, state, provenance, report: quiet })
    expect(second).toMatchObject({ added: 0, changed: 0, unchanged: 4 })
    expect(store.gets).toEqual([])

    // A change and a removal.
    store.put('corp/docs/leave.md', '# Leave\n\ngammaleave')
    store.objects.delete('corp/src/a.ts')
    const third = await sweep({ source: source(store), mapping, index, state, provenance, report: quiet })
    expect(third).toMatchObject({ changed: 1, removed: 1, unchanged: 2 })
    expect(store.gets).toEqual(['corp/docs/leave.md'])
    expect(index.removes).toHaveLength(1)
  })

  it('reads the whole bucket when the prefix is empty', async () => {
    const store = new MemoryStore()
    store.put('docs/a.md', 'a')
    const items = []
    for await (const item of source(store, '').list()) items.push(item)
    expect(items.map((i) => i.fields['path'])).toEqual(['docs/a.md'])
  })
})
