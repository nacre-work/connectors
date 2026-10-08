import { describe, expect, it } from 'vitest'
import { matchesGlob } from '../glob.js'

describe('globs', () => {
  it.each([
    ['docs/**', 'docs/a.md', true],
    ['docs/**', 'docs/x/y/z.md', true],
    ['docs/**', 'docs', false],
    ['docs/**', 'src/docs/a.md', false],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'src/a/b.ts', true],
    ['**/*.ts', 'src/a/b.tsx', false],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/a/b.ts', false],
    ['**', 'anything/at/all', true],
    ['a?c', 'abc', true],
    ['a?c', 'a/c', false],
    ['a.b', 'axb', false],
  ])('%s against %s → %s', (glob, path, expected) => {
    expect(matchesGlob(path, glob)).toBe(expected)
  })
})
