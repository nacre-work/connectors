#!/usr/bin/env node
/**
 * The kit's binary format table is the core's, row for row.
 *
 * `packages/kit/src/formats.ts` tells a connector which type to declare for a
 * file it lists; the index judges that declaration by `packages/core/formats.ts`
 * in the nacre repository. Two copies of one table, across a boundary no
 * import can cross — a connector carries the SDK and nothing of the core — so
 * this is the thing that knows there are two.
 *
 * The core's copy is read at the version the kit's SDK resolves to: the SDK
 * and the core share a version by the core's own release rule, so the tag
 * `v{sdk version}` names the core this kit is written against. Rows are
 * compared as text, in the one-line shape both files keep for exactly this.
 * A fetch that fails is a failure and never a pass.
 */
import { readFileSync } from 'node:fs'

const ROW = /\{ contentType: '([^']+)', format: '([^']+)', family: '([^']+)', extension: '([^']+)' \}/g

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

function rows(text, where) {
  const found = [...text.matchAll(ROW)].map((m) => m.slice(1).join(' | '))
  if (found.length === 0) fail(`${where}: no table rows found; the row shape moved and this check reads nothing`)
  return found
}

// Read off the installed package rather than off the kit's range: a range
// names several versions and the check wants the one the kit is built with.
const { version } = JSON.parse(
  readFileSync(new URL('../packages/kit/node_modules/@nacre.work/sdk/package.json', import.meta.url), 'utf8'),
)
const url = `https://raw.githubusercontent.com/nacre-work/nacre/v${version}/packages/core/formats.ts`

const ours = rows(readFileSync(new URL('../packages/kit/src/formats.ts', import.meta.url), 'utf8'), 'packages/kit/src/formats.ts')

const response = await fetch(url).catch((e) => fail(`could not fetch ${url}: ${e instanceof Error ? e.message : String(e)}`))
if (!response.ok) fail(`${url} answered ${String(response.status)}; the core at v${version} could not be read, and a check that cannot read must not pass`)
const theirs = rows(await response.text(), url)

// The aliases too: a spelling the index admits that a connector sends as
// itself is a row the index canonicalises and this table would refuse.
const aliases = (text, where) => {
  const block = /ALIASES[^{]*\{([^}]*)\}/.exec(text)
  if (block === null) fail(`${where}: no ALIASES block found`)
  return [...block[1].matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => `${m[1]} -> ${m[2]}`).sort()
}
const ourAliases = aliases(readFileSync(new URL('../packages/kit/src/formats.ts', import.meta.url), 'utf8'), 'packages/kit/src/formats.ts')
const theirAliases = aliases(await (await fetch(url)).text(), url)
if (ourAliases.join('\n') !== theirAliases.join('\n')) fail(`the aliases differ — kit: ${ourAliases.join(', ') || 'none'}; core: ${theirAliases.join(', ') || 'none'}`)

const missing = theirs.filter((r) => !ours.includes(r))
const extra = ours.filter((r) => !theirs.includes(r))
if (missing.length > 0) fail(`the core at v${version} has rows the kit lacks — files it would read that a connector skips as binary:\n  ${missing.join('\n  ')}`)
if (extra.length > 0) fail(`the kit has rows the core at v${version} lacks — types the index would refuse on every sweep:\n  ${extra.join('\n  ')}`)
console.log(`${String(ours.length)} binary format(s), the same rows as the core at v${version}.`)
