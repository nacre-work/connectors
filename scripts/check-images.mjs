/**
 * Every connector is an image, and the release knows it exists.
 *
 * A connector directory is the unit: it has a Dockerfile, a README, a
 * manifest named after it, and a row in the release matrix — which is read out
 * of the workflow rather than kept as a second list. Versions agree across
 * connectors, because one tag releases them all.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const problems = []
const fail = (m) => problems.push(m)

const connectors = readdirSync('connectors').filter((d) => statSync(join('connectors', d)).isDirectory())
if (connectors.length === 0) fail('no connector under connectors/')

function matrix(workflow) {
  const text = readFileSync(workflow, 'utf8')
  const m = /connector:\s*\[([^\]]*)\]/.exec(text)
  if (!m) {
    fail(`${workflow}: no \`connector: [ … ]\` matrix`)
    return new Set()
  }
  return new Set(m[1].split(',').map((s) => s.trim()).filter(Boolean))
}

const versions = new Map()
for (const name of connectors) {
  const dir = join('connectors', name)
  for (const file of ['Dockerfile', 'README.md', 'package.json']) {
    if (!existsSync(join(dir, file))) fail(`${name}: no ${file}`)
  }
  if (existsSync(join(dir, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (pkg.name !== `@nacre.work/connector-${name}`) fail(`${name}: package.json names ${pkg.name}, expected @nacre.work/connector-${name}`)
    if (pkg.private !== true) fail(`${name}: must be private — a connector ships as an image, never to a registry`)
    versions.set(name, pkg.version)
  }
  if (existsSync(join(dir, 'Dockerfile'))) {
    const df = readFileSync(join(dir, 'Dockerfile'), 'utf8')
    if (!df.includes(`connectors/${name}/dist/main.js`)) fail(`${name}: Dockerfile does not run connectors/${name}/dist/main.js`)
    if (!/^USER node/m.test(df)) fail(`${name}: Dockerfile does not drop to USER node`)
  }
}
if (new Set(versions.values()).size > 1) {
  fail(`connectors disagree on a version: ${[...versions].map(([n, v]) => `${n}=${v}`).join(', ')} — one tag releases them all`)
}

for (const wf of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
  if (!existsSync(wf)) {
    fail(`${wf} is missing`)
    continue
  }
  const listed = matrix(wf)
  for (const name of connectors) if (!listed.has(name)) fail(`${wf}: the matrix does not build ${name}`)
  for (const name of listed) if (!connectors.includes(name)) fail(`${wf}: the matrix builds ${name}, which is not under connectors/`)
}

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`)
  process.exit(1)
}
console.log(`${String(connectors.length)} connector(s), each with an image, a README and a row in both workflows, all at ${[...versions.values()][0]}.`)
