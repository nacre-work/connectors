/**
 * What a path offers a template, and the rules that turn one into a layer.
 *
 * Every source that lists files — a repository, a bucket, a share — has the
 * same two questions: which files, and into which layer. Both are answered
 * over the path, in the same words (`docs/**=handbook`), so the answers live
 * here once rather than once per connector.
 */
import { basename, dirname, extname } from 'node:path'
import { compile, type Fields, type Template } from './expression.js'

export interface LayerRule {
  readonly glob: string
  readonly layer: Template
}

/** `glob=layer;glob=layer`, first match wins. The right side is a template over the path fields. */
export function parseLayerRules(spec: string, name: string): LayerRule[] {
  const rules: LayerRule[] = []
  for (const part of spec.split(';')) {
    const rule = part.trim()
    if (rule === '') continue
    const eq = rule.indexOf('=')
    if (eq <= 0) throw new Error(`${name}: ${JSON.stringify(rule)} is not glob=layer`)
    rules.push({ glob: rule.slice(0, eq).trim(), layer: compile(rule.slice(eq + 1).trim(), `${name} (${rule.slice(0, eq).trim()})`) })
  }
  if (rules.length === 0) throw new Error(`${name} names no rule; every file needs a layer, written as glob=layer`)
  return rules
}

/** A comma-separated list of globs; blanks dropped. */
export function parseGlobs(spec: string): string[] {
  return spec
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g !== '')
}

/** The fields a path offers to every template. */
export function pathFields(path: string): Fields {
  const ext = extname(path)
  const dir = dirname(path)
  return {
    path,
    name: basename(path),
    dir: dir === '.' ? '' : dir,
    ext: ext.startsWith('.') ? ext.slice(1) : ext,
    top: path.includes('/') ? (path.split('/')[0] as string) : '',
  }
}
