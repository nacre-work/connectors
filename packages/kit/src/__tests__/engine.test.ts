import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileMapping, IndexRefusal, sweep, type Index, type Item, type Mapped, type Source } from '../engine.js'
import { State } from '../state.js'

/**
 * The engine against a fake index that records every verb. The fake proves
 * the engine's arithmetic — which items become which calls — and nothing
 * about what the real index does with a call; that half is the live run.
 */
class FakeIndex implements Index {
  readonly adds: Mapped[] = []
  readonly removes: string[] = []
  readonly docs = new Map<string, string>()
  refuse: ((doc: Mapped) => Error | undefined) | undefined
  failRemove = false
  #n = 0

  async add(doc: Mapped) {
    const refusal = this.refuse?.(doc)
    if (refusal !== undefined) throw refusal
    this.adds.push(doc)
    const key = `${doc.layer}/${doc.externalId}`
    const existing = this.docs.get(key)
    const id = existing ?? `doc-${String(++this.#n)}`
    this.docs.set(key, id)
    return { documentId: id, unchanged: false }
  }

  async remove(documentId: string) {
    if (this.failRemove) throw new Error('index down')
    this.removes.push(documentId)
    for (const [k, v] of this.docs) if (v === documentId) this.docs.delete(k)
    return true
  }
}

function sourceOf(items: readonly { id: string; version?: string; text: string; dept?: string }[], opts: { failAfter?: number; fetches?: string[] } = {}): Source {
  return {
    async *list() {
      let n = 0
      for (const item of items) {
        if (opts.failAfter !== undefined && n === opts.failAfter) throw new Error('the source went away')
        n += 1
        yield { id: item.id, ...(item.version === undefined ? {} : { version: item.version }), fields: { path: item.id, dept: item.dept ?? 'docs' } }
      }
    },
    async fetch(item: Item) {
      opts.fetches?.push(item.id)
      const found = items.find((i) => i.id === item.id)
      return { content: found?.text ?? '' }
    },
  }
}

const mapping = compileMapping({ layer: '${dept}', externalId: '${path}', title: '${path}', content: '${content}', metadata: { path: '${path}' } })
const provenance = { connector: 'test', source: 'memory' }
const quiet = { skipped: () => undefined, failed: () => undefined }
const fresh = () => new State(join(mkdtempSync(join(tmpdir(), 'kit-engine-')), 's.sqlite'))

describe('the three verbs', () => {
  it('adds what is new, changes what moved, removes what a complete listing no longer has', async () => {
    const state = fresh()
    const index = new FakeIndex()
    const run = (items: Parameters<typeof sourceOf>[0]) => sweep({ source: sourceOf(items), mapping, index, state, provenance, report: quiet })

    const first = await run([
      { id: 'a.md', text: 'alpha' },
      { id: 'b.md', text: 'beta' },
    ])
    expect(first).toMatchObject({ complete: true, listed: 2, added: 2, changed: 0, unchanged: 0, removed: 0, failed: 0 })
    expect(index.adds.map((d) => [d.layer, d.externalId, d.content])).toEqual([
      ['docs', 'a.md', 'alpha'],
      ['docs', 'b.md', 'beta'],
    ])
    expect(index.adds[0]?.metadata).toEqual({ connector: 'test', source: 'memory', path: 'a.md' })

    const second = await run([
      { id: 'a.md', text: 'alpha' },
      { id: 'b.md', text: 'beta changed' },
    ])
    expect(second).toMatchObject({ complete: true, added: 0, changed: 1, unchanged: 1, removed: 0 })

    const third = await run([{ id: 'b.md', text: 'beta changed' }])
    expect(third).toMatchObject({ complete: true, added: 0, changed: 0, unchanged: 1, removed: 1 })
    expect(index.removes).toEqual(['doc-1'])
    expect(state.count()).toBe(1)
  })

  /**
   * The property that makes removal safe to run unattended: a listing that
   * breaks off has said nothing about what it did not reach.
   */
  it('removes nothing when the listing does not complete', async () => {
    const state = fresh()
    const index = new FakeIndex()
    await sweep({ source: sourceOf([{ id: 'a.md', text: 'a' }, { id: 'b.md', text: 'b' }]), mapping, index, state, provenance, report: quiet })
    // Two items and a break after the first: the second is never reached, and
    // a listing that never reached it has not said it is gone.
    const broken = await sweep({ source: sourceOf([{ id: 'a.md', text: 'a' }, { id: 'b.md', text: 'b' }], { failAfter: 1 }), mapping, index, state, provenance, report: quiet })
    expect(broken.complete).toBe(false)
    expect(broken.error).toMatch(/went away/)
    expect(broken.removed).toBe(0)
    expect(index.removes).toEqual([])
    expect(state.count()).toBe(2)
  })

  it('skips an unchanged version without fetching it', async () => {
    const state = fresh()
    const index = new FakeIndex()
    const fetches: string[] = []
    await sweep({ source: sourceOf([{ id: 'a.md', version: 'blob1', text: 'a' }], { fetches }), mapping, index, state, provenance, report: quiet })
    const again = await sweep({ source: sourceOf([{ id: 'a.md', version: 'blob1', text: 'a' }], { fetches }), mapping, index, state, provenance, report: quiet })
    expect(again.unchanged).toBe(1)
    expect(fetches).toEqual(['a.md'])
    const moved = await sweep({ source: sourceOf([{ id: 'a.md', version: 'blob2', text: 'a2' }], { fetches }), mapping, index, state, provenance, report: quiet })
    expect(moved.changed).toBe(1)
    expect(fetches).toEqual(['a.md', 'a.md'])
  })

  it('counts a layer the index refuses and a missing field as skips, and keeps going', async () => {
    const state = fresh()
    const index = new FakeIndex()
    index.refuse = (doc) => (doc.layer === 'nowhere' ? new IndexRefusal('layer_missing', 'no such layer') : undefined)
    const skipped: string[] = []
    const r = await sweep({
      source: sourceOf([{ id: 'a.md', text: 'a', dept: 'nowhere' }, { id: 'b.md', text: 'b' }, { id: 'c.md', text: '   ' }]),
      mapping,
      index,
      state,
      provenance,
      report: { skipped: (reason, item) => skipped.push(`${reason}:${item}`), failed: () => undefined },
    })
    expect(r).toMatchObject({ complete: true, added: 1, failed: 0 })
    expect(r.skipped).toEqual({ layer_missing: 1, empty: 1 })
    expect(skipped).toEqual(['layer_missing:a.md', 'empty:c.md'])
  })

  /**
   * A changed document the index could not take is still in the source. The
   * sweep that refused it must not then remove it as unseen.
   */
  it('does not remove a listed document whose change the index failed to take', async () => {
    const state = fresh()
    const index = new FakeIndex()
    await sweep({ source: sourceOf([{ id: 'a.md', text: 'a' }]), mapping, index, state, provenance, report: quiet })
    index.refuse = () => new Error('503 for everybody')
    const r = await sweep({ source: sourceOf([{ id: 'a.md', text: 'a changed' }]), mapping, index, state, provenance, report: quiet })
    expect(r).toMatchObject({ complete: true, failed: 1, removed: 0 })
    expect(index.removes).toEqual([])
    expect(state.get('docs', 'a.md')?.contentHash).toBeDefined()
  })

  it('keeps a document the index would not let go, and tries again next sweep', async () => {
    const state = fresh()
    const index = new FakeIndex()
    await sweep({ source: sourceOf([{ id: 'a.md', text: 'a' }]), mapping, index, state, provenance, report: quiet })
    index.failRemove = true
    const r = await sweep({ source: sourceOf([]), mapping, index, state, provenance, report: quiet })
    expect(r).toMatchObject({ complete: true, removed: 0, failed: 1 })
    expect(state.count()).toBe(1)
    index.failRemove = false
    const again = await sweep({ source: sourceOf([]), mapping, index, state, provenance, report: quiet })
    expect(again.removed).toBe(1)
    expect(state.count()).toBe(0)
  })

  it('moves a document whose mapping now puts it in another layer', async () => {
    const state = fresh()
    const index = new FakeIndex()
    await sweep({ source: sourceOf([{ id: 'a.md', text: 'a', dept: 'old' }]), mapping, index, state, provenance, report: quiet })
    const r = await sweep({ source: sourceOf([{ id: 'a.md', text: 'a', dept: 'new' }]), mapping, index, state, provenance, report: quiet })
    expect(r).toMatchObject({ added: 1, removed: 1 })
    expect([...index.docs.keys()]).toEqual(['new/a.md'])
  })
})

/** A source whose items are files: the listing carries the key and an ETag, the fetch carries bytes under a type. */
function filesOf(items: readonly { id: string; version: string; bytes: Uint8Array; type?: string }[]): Source {
  return {
    async *list() {
      for (const item of items) yield { id: item.id, version: item.version, fields: { path: item.id, dept: 'docs' } }
    },
    async fetch(item: Item) {
      const found = items.find((i) => i.id === item.id)
      if (found === undefined) return {}
      return found.type === undefined ? { bytes: found.bytes } : { bytes: found.bytes, content_type: found.type }
    },
  }
}

describe('binary documents', () => {
  const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4 ${text}`)

  it('sends a file as bytes under its declared type, hashed over the bytes, and never through the content template', async () => {
    const state = new State(join(mkdtempSync(join(tmpdir(), 'kit-')), 'state.sqlite'))
    const index = new FakeIndex()
    const run = (items: Parameters<typeof filesOf>[0]) => sweep({ source: filesOf(items), mapping, index, state, provenance, report: quiet })

    const first = await run([{ id: 'a.pdf', version: 'etag-1', bytes: pdf('alpha'), type: 'application/pdf' }])
    expect(first).toMatchObject({ added: 1, skipped: {} })
    expect(index.adds[0]?.content).toBeUndefined()
    expect(index.adds[0]?.contentType).toBe('application/pdf')
    expect(index.adds[0]?.bytes).toEqual(pdf('alpha'))

    // Same bytes under a new ETag: fetched, hashed, found unchanged.
    const same = await run([{ id: 'a.pdf', version: 'etag-2', bytes: pdf('alpha'), type: 'application/pdf' }])
    expect(same).toMatchObject({ added: 0, changed: 0, unchanged: 1 })

    // New bytes: a change.
    const moved = await run([{ id: 'a.pdf', version: 'etag-3', bytes: pdf('beta'), type: 'application/pdf' }])
    expect(moved).toMatchObject({ changed: 1 })
    expect(index.adds).toHaveLength(2)
  })

  it('refuses to guess a type, and bounds the bytes the way it bounds text', async () => {
    const state = new State(join(mkdtempSync(join(tmpdir(), 'kit-')), 'state.sqlite'))
    const index = new FakeIndex()
    const skipped: [string, string][] = []
    const report = { skipped: (reason: string, item: string) => void skipped.push([reason, item]), failed: () => undefined }

    const outcome = await sweep({
      source: filesOf([
        { id: 'untyped.bin', version: 'v', bytes: pdf('x') },
        { id: 'empty.pdf', version: 'v', bytes: new Uint8Array(), type: 'application/pdf' },
        { id: 'big.pdf', version: 'v', bytes: new Uint8Array(2048), type: 'application/pdf' },
        { id: 'fine.pdf', version: 'v', bytes: pdf('ok'), type: 'application/pdf' },
      ]),
      mapping,
      index,
      state,
      provenance,
      report,
      maxBytes: 1024,
    })

    expect(outcome).toMatchObject({ added: 1, skipped: { missing_field: 1, empty: 1, oversize: 1 } })
    expect(skipped).toEqual([
      ['missing_field', 'untyped.bin'],
      ['empty', 'empty.pdf'],
      ['oversize', 'big.pdf'],
    ])
    expect(index.adds.map((d) => d.externalId)).toEqual(['fine.pdf'])
  })
})

describe('remembered skips', () => {
  it('does not fetch an item again to skip it again while its version holds, and forgets the skip once it maps', async () => {
    const state = new State(join(mkdtempSync(join(tmpdir(), 'kit-')), 'state.sqlite'))
    const index = new FakeIndex()
    const fetches: string[] = []
    const png = { id: 'logo.png', version: 'v1', bytes: new Uint8Array([0x89, 0x50]) }
    const counting = (items: Parameters<typeof filesOf>[0]): Source => {
      const inner = filesOf(items)
      return { list: () => inner.list(), fetch: (item: Item) => (fetches.push(item.id), inner.fetch(item)) }
    }
    const skipped: string[] = []
    const report = { skipped: (reason: string, item: string) => void skipped.push(`${reason}:${item}`), failed: () => undefined }

    // No content_type: a missing field, decided from the bytes.
    const first = await sweep({ source: counting([png]), mapping, index, state, provenance, report })
    expect(first.skipped).toEqual({ missing_field: 1 })
    expect(fetches).toEqual(['logo.png'])

    // Same version: counted again, fetched never.
    const second = await sweep({ source: counting([png]), mapping, index, state, provenance, report })
    expect(second.skipped).toEqual({ missing_field: 1 })
    expect(fetches).toEqual(['logo.png'])
    expect(skipped).toEqual(['missing_field:logo.png', 'missing_field:logo.png'])

    // A new version is new bytes: fetched, and this time it maps.
    const third = await sweep({ source: counting([{ ...png, version: 'v2', type: 'application/pdf' }]), mapping, index, state, provenance, report })
    expect(third).toMatchObject({ added: 1, skipped: {} })
    expect(fetches).toEqual(['logo.png', 'logo.png'])

    // Back to bytes that do not map, under a version seen before as fine:
    // the skip was forgotten on the add, so this is decided afresh.
    const fourth = await sweep({ source: counting([{ ...png, version: 'v3' }]), mapping, index, state, provenance, report })
    expect(fourth.skipped).toEqual({ missing_field: 1 })
    expect(fetches).toHaveLength(3)
  })
})
