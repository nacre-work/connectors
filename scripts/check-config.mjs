/**
 * Every variable read is documented, and every variable documented is read.
 *
 * Discovered, never listed: the readers are found by reading the sources
 * (`required('X')`, `optional('X', …)`, `integer('X', …)`, `boolean('X', …)`,
 * `process.env['X']`, `process.env.X`), the documentation by reading the
 * tables. Two scopes, because a shared variable documented in every
 * connector's README is one table per connector to drift: the kit's readers
 * are held against the root README, each connector's against its own.
 *
 * A scope that reads nothing is a refusal — a check with nothing to hold must
 * not report green.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const problems = []
const fail = (m) => problems.push(m)

function sources(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules' && entry !== 'dist') out.push(...sources(p))
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

function readers(dir) {
  const found = new Map()
  for (const file of sources(dir)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/\b(?:required|optional|integer|boolean)\('([A-Z][A-Z0-9_]+)'/g)) found.set(m[1], file)
    for (const m of text.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]+)|\['([A-Z][A-Z0-9_]+)'\])/g)) found.set(m[1] ?? m[2], file)
  }
  return found
}

function documented(readme) {
  const out = new Set()
  for (const line of readFileSync(readme, 'utf8').split('\n')) {
    const m = /^\| `([A-Z][A-Z0-9_]+)` \|/.exec(line)
    if (m) out.add(m[1])
  }
  return out
}

function hold(label, read, docs, readme) {
  if (read.size === 0) fail(`${label}: no variable is read, so there is nothing to hold — the discovery has gone stale`)
  for (const [name, file] of read) if (!docs.has(name)) fail(`${label}: ${name} is read in ${file} and not documented in ${readme}`)
  for (const name of docs) if (!read.has(name)) fail(`${label}: ${name} is documented in ${readme} and read by nothing`)
}

const kitRead = readers('packages/kit/src')
hold('kit', kitRead, documented('README.md'), 'README.md')

const connectors = readdirSync('connectors').filter((d) => statSync(join('connectors', d)).isDirectory())
if (connectors.length === 0) fail('no connector under connectors/, so this check holds nothing')
let total = kitRead.size
for (const name of connectors) {
  const dir = join('connectors', name)
  const read = readers(join(dir, 'src'))
  for (const shared of kitRead.keys()) read.delete(shared)
  const docs = documented(join(dir, 'README.md'))
  for (const shared of kitRead.keys()) {
    if (docs.has(shared)) fail(`${name}: ${shared} is a shared variable and belongs in the root README only; a second table is a second claim`)
  }
  hold(name, read, docs, `${dir}/README.md`)
  total += read.size
}

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`)
  process.exit(1)
}
console.log(`${String(total)} variable(s) across the kit and ${String(connectors.length)} connector(s), each read and documented.`)
