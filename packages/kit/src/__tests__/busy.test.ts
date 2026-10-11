import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NacreError, type NacreClient } from '@nacre.work/sdk'
import { describe, expect, it } from 'vitest'
import { compileMapping, IndexBusy, IndexRefusal, MAX_WAITS, sweep, type Index, type Item, type Mapped, type Source } from '../engine.js'
import { nacreIndex } from '../nacre.js'
import { EXIT_DEFERRED, verdict } from '../run.js'
import { State } from '../state.js'

/**
 * An index with no room: a `429` and the wait it names. The core answers one
 * when a caller or an organization has spent its budget — per caller in
 * seconds, ingest per organization by the hour — and a connector's first sync
 * of a large source is exactly the caller that spends it. What is held here is
 * that the engine waits where the wait is short, pauses where it is long, and
 * in neither case calls a document the index will take later a failure.
 */

/** Takes `room` documents, then refuses every add with `retryAfter`; `room` can be raised mid-run. */
class BusyIndex implements Index {
  readonly adds: Mapped[] = []
  readonly removes: string[] = []
  attempts = 0
  room = Number.POSITIVE_INFINITY
  removeRoom = Number.POSITIVE_INFINITY
  retryAfter: number | undefined = 2500
  #n = 0

  async add(doc: Mapped) {
    this.attempts += 1
    if (this.adds.length >= this.room) throw new IndexBusy(this.retryAfter, '429: out of room')
    this.adds.push(doc)
    return { documentId: `doc-${String(++this.#n)}-${doc.externalId}`, unchanged: false }
  }

  async remove(documentId: string) {
    if (this.removes.length >= this.removeRoom) throw new IndexBusy(this.retryAfter, '429: out of room')
    this.removes.push(documentId)
    return true
  }
}

interface Entry {
  readonly id: string
  readonly version?: string
  readonly text: string
}

function sourceOf(items: readonly Entry[], opts: { fetches?: string[]; beforeEach?: (i: number) => void } = {}): Source {
  return {
    async *list() {
      for (const [i, item] of items.entries()) {
        opts.beforeEach?.(i)
        yield { id: item.id, ...(item.version === undefined ? {} : { version: item.version }), fields: { path: item.id } }
      }
    },
    async fetch(item: Item) {
      opts.fetches?.push(item.id)
      return { content: items.find((i) => i.id === item.id)?.text ?? '' }
    },
  }
}

const mapping = compileMapping({ layer: 'docs', externalId: '${path}', content: '${content}' })
const provenance = { connector: 'test', source: 'memory' }
const fresh = () => new State(join(mkdtempSync(join(tmpdir(), 'kit-busy-')), 's.sqlite'))
const files = (n: number, version = 'v1'): Entry[] =>
  Array.from({ length: n }, (_, i) => ({ id: `page-${String(i + 1)}.md`, version, text: `page ${String(i + 1)} ${version}` }))

function recorder() {
  const paused: [string, string, number | undefined][] = []
  const failed: string[] = []
  return {
    paused,
    failed,
    report: {
      skipped: () => undefined,
      failed: (_verb: string, item: string) => void failed.push(item),
      paused: (verb: string, item: string, seconds: number | undefined) => void paused.push([verb, item, seconds]),
    },
  }
}

describe('an index with no room', () => {
  it('sits through a short wait and sends the same document again', async () => {
    const index = new BusyIndex()
    const slept: number[] = []
    // Out of room once, for five seconds — the per-caller budget refilling.
    let refused = false
    const add = index.add.bind(index)
    index.add = async (doc: Mapped) => {
      if (!refused) {
        refused = true
        throw new IndexBusy(5, '429: wait five seconds')
      }
      return add(doc)
    }
    const { report, paused } = recorder()
    const r = await sweep({ source: sourceOf(files(2)), mapping, index, state: fresh(), provenance, report, sleep: async (ms) => void slept.push(ms) })

    expect(slept).toEqual([5000])
    expect(index.adds.map((d) => d.externalId)).toEqual(['page-1.md', 'page-2.md'])
    expect(r).toMatchObject({ complete: true, added: 2, failed: 0, deferred: 0, resumeAt: null })
    expect(paused).toEqual([])
  })

  it('pauses on a long wait: holds the rest back, fetches none of it, and fails nothing', async () => {
    const index = new BusyIndex()
    index.room = 3
    const fetches: string[] = []
    const t0 = Date.parse('2026-10-11T08:00:00Z')
    const { report, paused, failed } = recorder()
    const r = await sweep({
      source: sourceOf(files(10), { fetches }),
      mapping,
      index,
      state: fresh(),
      provenance,
      report,
      now: () => new Date(t0),
      sleep: async () => {
        throw new Error('a wait this long is not slept inside a sweep')
      },
    })

    expect(r).toMatchObject({ complete: true, listed: 10, added: 3, failed: 0, deferred: 7 })
    expect(r.resumeAt).toBe(new Date(t0 + 2500 * 1000).toISOString())
    // The refusal is asked once; nothing after it reaches the index or the source's fetch.
    expect(index.attempts).toBe(4)
    expect(fetches).toEqual(['page-1.md', 'page-2.md', 'page-3.md', 'page-4.md'])
    expect(paused).toEqual([['add', 'page-4.md', 2500]])
    expect(failed).toEqual([])
  })

  it('remembers nothing it held back, so the next sweep sends exactly that', async () => {
    const index = new BusyIndex()
    index.room = 3
    const state = fresh()
    const run = () => sweep({ source: sourceOf(files(10)), mapping, index, state, provenance, report: recorder().report })

    expect(await run()).toMatchObject({ added: 3, deferred: 7 })
    index.room = Number.POSITIVE_INFINITY
    expect(await run()).toMatchObject({ added: 7, unchanged: 3, deferred: 0, failed: 0, removed: 0 })
    expect(new Set(index.adds.map((d) => d.externalId)).size).toBe(10)
  })

  it('keeps a document it could not update rather than removing it as unseen', async () => {
    const index = new BusyIndex()
    const state = fresh()
    const run = (version: string) => sweep({ source: sourceOf(files(4, version)), mapping, index, state, provenance, report: recorder().report })

    expect(await run('v1')).toMatchObject({ added: 4 })
    // Every file changed, and the index has room for one.
    index.room = 5
    const second = await run('v2')
    expect(second).toMatchObject({ complete: true, changed: 1, deferred: 3, removed: 0 })
    expect(index.removes).toEqual([])

    index.room = Number.POSITIVE_INFINITY
    expect(await run('v2')).toMatchObject({ changed: 3, unchanged: 1, removed: 0, deferred: 0 })
  })

  it('resumes sending when the wait runs out before the listing does', async () => {
    const index = new BusyIndex()
    let clock = Date.parse('2026-10-11T08:00:00Z')
    // A slow listing: a minute between items, so the pause ends partway.
    const source = sourceOf(files(4), { beforeEach: (i) => void (clock += i === 0 ? 0 : 60_000) })
    const add = index.add.bind(index)
    let refusedOnce = false
    index.add = async (doc: Mapped) => {
      if (index.adds.length === 1 && !refusedOnce) {
        refusedOnce = true
        throw new IndexBusy(90, '429: ninety seconds')
      }
      return add(doc)
    }
    const r = await sweep({ source, mapping, index, state: fresh(), provenance, report: recorder().report, now: () => new Date(clock) })

    // page-2 refused at t+60s and held until t+150s; page-3 is listed at
    // t+120s, still held; page-4 at t+180s, sent.
    expect(index.adds.map((d) => d.externalId)).toEqual(['page-1.md', 'page-4.md'])
    expect(r).toMatchObject({ added: 2, deferred: 2, failed: 0, resumeAt: null })
  })

  it('holds a removal back and removes it on a later sweep', async () => {
    const index = new BusyIndex()
    const state = fresh()
    const run = (entries: Entry[]) => sweep({ source: sourceOf(entries), mapping, index, state, provenance, report: recorder().report })

    expect(await run(files(3))).toMatchObject({ added: 3 })
    index.removeRoom = 1
    const second = await run([])
    expect(second).toMatchObject({ complete: true, removed: 1, deferred: 2, failed: 0 })
    expect(state.count()).toBe(2)

    index.removeRoom = Number.POSITIVE_INFINITY
    expect(await run([])).toMatchObject({ removed: 2, deferred: 0 })
    expect(state.count()).toBe(0)
  })

  it('pauses for the rest of the sweep when the index names no time', async () => {
    const index = new BusyIndex()
    index.room = 1
    index.retryAfter = undefined
    let clock = Date.parse('2026-10-11T08:00:00Z')
    const source = sourceOf(files(4), { beforeEach: () => void (clock += 3_600_000) })
    const r = await sweep({ source, mapping, index, state: fresh(), provenance, report: recorder().report, now: () => new Date(clock) })
    expect(r).toMatchObject({ added: 1, deferred: 3, resumeAt: null })
  })

  it('gives a request a bounded number of short waits, then pauses', async () => {
    const index = new BusyIndex()
    index.room = 0
    index.retryAfter = 5
    const slept: number[] = []
    const r = await sweep({ source: sourceOf(files(2)), mapping, index, state: fresh(), provenance, report: recorder().report, sleep: async (ms) => void slept.push(ms) })
    expect(slept).toEqual(Array.from({ length: MAX_WAITS }, () => 5000))
    expect(r).toMatchObject({ added: 0, deferred: 2, failed: 0 })
  })
})

describe('what a one-shot run exits with', () => {
  it('is 0 when everything went, 75 when the index asked to wait, 1 when anything failed', () => {
    expect(verdict({ complete: true, failed: 0, deferred: 0 })).toBe(0)
    expect(verdict({ complete: true, failed: 0, deferred: 7 })).toBe(EXIT_DEFERRED)
    expect(EXIT_DEFERRED).toBe(75)
    expect(verdict({ complete: true, failed: 1, deferred: 7 })).toBe(1)
    expect(verdict({ complete: false, failed: 0, deferred: 7 })).toBe(1)
  })
})

describe('the SDK behind the port', () => {
  const problem = (status: number, detail: string) => ({ type: 'about:blank', title: 'x', status, detail, instance: '/v1/documents', request_id: 'req-1' })
  const client = (error: Error) =>
    ({
      documents: {
        add: async () => {
          throw error
        },
        remove: async () => {
          throw error
        },
      },
    }) as unknown as NacreClient
  const doc: Mapped = { layer: 'docs', externalId: 'a.md', title: undefined, metadata: {}, content: 'a' }

  it('turns a 429 into IndexBusy carrying the wait, on adding and on removing', async () => {
    const error = new NacreError(problem(429, 'The ingest limit for this organization is 600 per 3600 seconds.'), { retryAfter: 2501 })
    const index = nacreIndex(client(error))
    await expect(index.add(doc)).rejects.toMatchObject({ name: 'IndexBusy', retryAfterSeconds: 2501 })
    await expect(index.remove('d')).rejects.toBeInstanceOf(IndexBusy)
  })

  it('leaves a 404 a refusal and a 500 an error', async () => {
    await expect(nacreIndex(client(new NacreError(problem(404, 'not found')))).add(doc)).rejects.toBeInstanceOf(IndexRefusal)
    const down = new NacreError(problem(500, 'boom'))
    await expect(nacreIndex(client(down)).add(doc)).rejects.toBe(down)
  })
})
