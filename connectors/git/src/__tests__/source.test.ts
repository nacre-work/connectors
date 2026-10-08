import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileMapping, State, sweep, type Index, type Mapped } from '@nacre.work/connector-kit'
import { beforeAll, describe, expect, it } from 'vitest'
import { GitSource, parseLayerRules, pathFields } from '../source.js'

/**
 * A real repository, driven through real git: the listing and the blob reads
 * are what this connector is, and a stub of `git` would prove the stub.
 */
const root = mkdtempSync(join(tmpdir(), 'connector-git-'))
const work = join(root, 'work')
const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
const write = (path: string, text: string | Buffer) => {
  mkdirSync(join(work, path, '..'), { recursive: true })
  writeFileSync(join(work, path), text)
}
const commit = (msg: string) => {
  git('add', '-A')
  git('commit', '-q', '-m', msg)
}

class FakeIndex implements Index {
  readonly docs = new Map<string, Mapped>()
  readonly removed: string[] = []
  async add(doc: Mapped) {
    const key = `${doc.layer}/${doc.externalId}`
    this.docs.set(key, doc)
    return { documentId: `doc-${key}`, unchanged: false }
  }
  async remove(documentId: string) {
    this.removed.push(documentId)
    for (const [k] of this.docs) if (`doc-${k}` === documentId) this.docs.delete(k)
    return true
  }
}

const mapping = compileMapping({ layer: '${layer}', externalId: '${path}', title: '${name}', content: '${content}', metadata: { path: '${path}' } })
const quiet = { skipped: () => undefined, failed: () => undefined }
const provenance = { connector: 'git', source: 'test' }

beforeAll(() => {
  mkdirSync(work)
  git('init', '-q', '-b', 'main')
  write('docs/handbook.md', '# Handbook\n')
  write('docs/leave.md', '# Leave\n')
  write('src/a.ts', 'export const a = 1\n')
  write('src/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]))
  write('notes.txt', 'unmapped\n')
  commit('first')
})

function source(dir: string) {
  return new GitSource({
    url: work,
    ref: 'main',
    dir,
    include: ['**'],
    exclude: ['**/*.lock'],
    rules: parseLayerRules('docs/**=handbook;src/**=code-${ext}', 'GIT_LAYERS'),
    maxBytes: 1024 * 1024,
    credential: undefined,
  })
}

describe('path fields and rules', () => {
  it('derives what a template may read from a path', () => {
    expect(pathFields('docs/people/leave.md')).toEqual({ path: 'docs/people/leave.md', name: 'leave.md', dir: 'docs/people', ext: 'md', top: 'docs' })
    expect(pathFields('README')).toEqual({ path: 'README', name: 'README', dir: '', ext: '', top: '' })
  })
  it('refuses a rule that is not glob=layer, and an empty rule set', () => {
    expect(() => parseLayerRules('docs/**', 'GIT_LAYERS')).toThrow(/glob=layer/)
    expect(() => parseLayerRules(' ; ', 'GIT_LAYERS')).toThrow(/names no rule/)
  })
})

describe('the three verbs against a real repository', () => {
  it('adds the mapped text files, skips the binary and the unmapped, then changes and removes', async () => {
    const dir = join(root, 'mirror.git')
    const src = source(dir)
    await src.open()
    const state = new State(join(root, 's.sqlite'))
    const index = new FakeIndex()
    const skipped: string[] = []
    const report = { skipped: (reason: string, item: string) => skipped.push(`${reason}:${item}`), failed: () => undefined }

    const first = await sweep({ source: src, mapping, index, state, provenance, report })
    expect(first).toMatchObject({ complete: true, added: 3, removed: 0, failed: 0 })
    expect([...index.docs.keys()].sort()).toEqual(['code-ts/src/a.ts', 'handbook/docs/handbook.md', 'handbook/docs/leave.md'])
    expect(index.docs.get('handbook/docs/leave.md')?.content).toBe('# Leave\n')
    expect(skipped.sort()).toEqual(['binary:src/logo.png', 'unmapped:notes.txt'])
    expect(src.commit).toMatch(/^[0-9a-f]{40}$/)

    // Nothing moved: every blob is remembered by hash, nothing is read.
    const second = await sweep({ source: src, mapping, index, state, provenance, report: quiet })
    expect(second).toMatchObject({ added: 0, changed: 0, unchanged: 3, removed: 0 })

    write('docs/leave.md', '# Leave\n\nTwenty-eight days.\n')
    rmSync(join(work, 'docs/handbook.md'))
    commit('second')
    const third = await sweep({ source: src, mapping, index, state, provenance, report: quiet })
    expect(third).toMatchObject({ complete: true, added: 0, changed: 1, unchanged: 1, removed: 1 })
    expect(index.removed).toEqual(['doc-handbook/docs/handbook.md'])
    expect(index.docs.get('handbook/docs/leave.md')?.content).toContain('Twenty-eight')
    state.close()
  })
})
