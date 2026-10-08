import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { State } from '../state.js'

const fresh = () => new State(join(mkdtempSync(join(tmpdir(), 'kit-state-')), 's.sqlite'))

describe('the state', () => {
  it('remembers a document across a reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-state-'))
    const path = join(dir, 's.sqlite')
    const a = new State(path)
    const s = a.beginSweep(new Date())
    a.upsert(s, { layer: 'l', externalId: 'x', documentId: 'd1', contentHash: 'h', sourceVersion: 'v' })
    a.close()
    const b = new State(path)
    expect(b.get('l', 'x')?.documentId).toBe('d1')
    expect(b.count()).toBe(1)
    expect(b.layers()).toEqual(['l'])
  })

  it('names as unseen only what a finished sweep did not list', () => {
    const st = fresh()
    const s1 = st.beginSweep(new Date())
    st.upsert(s1, { layer: 'l', externalId: 'a', documentId: 'da', contentHash: 'h', sourceVersion: null })
    st.upsert(s1, { layer: 'l', externalId: 'b', documentId: 'db', contentHash: 'h', sourceVersion: null })
    st.finishSweep(s1, new Date())
    const s2 = st.beginSweep(new Date())
    st.markSeen(s2, 'l', 'a')
    st.finishSweep(s2, new Date())
    expect(st.unseen(s2).map((r) => r.externalId)).toEqual(['b'])
  })

  /**
   * The property the whole file exists for. A listing that stopped halfway
   * has not said anything about the half it never reached, so asking what it
   * did not list is refused rather than answered with "everything".
   */
  it('refuses to name anything unseen for a sweep that did not finish', () => {
    const st = fresh()
    const s1 = st.beginSweep(new Date())
    st.upsert(s1, { layer: 'l', externalId: 'a', documentId: 'da', contentHash: 'h', sourceVersion: null })
    st.finishSweep(s1, new Date())
    const s2 = st.beginSweep(new Date())
    expect(() => st.unseen(s2)).toThrow(/did not finish/)
  })

  it('keeps a cursor', () => {
    const st = fresh()
    expect(st.cursor('commit')).toBeUndefined()
    st.setCursor('commit', 'abc')
    st.setCursor('commit', 'def')
    expect(st.cursor('commit')).toBe('def')
  })
})
