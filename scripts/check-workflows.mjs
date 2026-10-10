/**
 * The aggregate `pnpm lint` runs every `lint:*`, the pull-request workflow runs
 * every one of them, and every workflow that gates a pull request can be
 * started by hand. The last rule lived in a comment in the core until the
 * day it was broken in a sibling repository; here it arrives as a check first.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const problems = []
const fail = (m) => problems.push(m)

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const gates = Object.keys(pkg.scripts).filter((k) => k.startsWith('lint:'))
const aggregate = String(pkg.scripts.lint ?? '')
for (const g of gates) if (!aggregate.includes(`pnpm ${g}`) && !new RegExp(`\\b${g}\\b`).test(aggregate)) fail(`package.json: \`pnpm lint\` does not run ${g}`)

const dir = '.github/workflows'
const files = readdirSync(dir).filter((f) => f.endsWith('.yml'))
if (files.length === 0) fail('no workflow at all')
for (const f of files) {
  const text = readFileSync(join(dir, f), 'utf8')
  if (/^\s*pull_request:/m.test(text) && !/workflow_dispatch/.test(text)) fail(`${f} gates pull requests and cannot be started by hand`)
  if (f === 'ci.yml') {
    for (const g of gates) if (!text.includes(`pnpm ${g}`)) fail(`ci.yml does not run ${g}`)
    for (const step of ['pnpm typecheck', 'pnpm test', 'pnpm build']) if (!text.includes(step)) fail(`ci.yml does not run ${step}`)
  }
}

// What a workflow's token may do, and whose code it runs — the core's rule
// from 0.38.0. A workflow that declares no permissions gets the repository's
// default, which an organization can set to write. An action outside
// `actions/` is pinned to a commit, because a tag is a pointer its owner can
// move and these run in jobs holding the registry credential that pushes the
// images a deployment pulls. The release stays beside the SHA as a comment.
let pinned = 0
for (const f of files) {
  const text = readFileSync(join(dir, f), 'utf8')
  if (!/^permissions:/m.test(text)) fail(`${f} declares no top-level permissions, so its token is whatever the repository's default is`)
  for (const m of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
    const ref = m[1] ?? ''
    if (ref.startsWith('./') || ref.startsWith('actions/') || ref.startsWith('docker://')) continue
    pinned += 1
    if (!/@[0-9a-f]{40}$/.test(ref)) fail(`${f}: ${ref} is referenced by a tag its owner can move; pin it to the commit`)
  }
}
if (pinned === 0) fail('no third-party action in any workflow; the pinning rule has nothing to hold, which is not a pass')

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`)
  process.exit(1)
}
console.log(`ci.yml runs all ${String(gates.length)} lint:* gate(s) plus build, typecheck and test; ${String(files.length)} workflow(s) can each be started by hand, declare their permissions, and pin ${String(pinned)} third-party action reference(s) to commits.`)
