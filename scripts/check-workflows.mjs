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

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`)
  process.exit(1)
}
console.log(`ci.yml runs all ${String(gates.length)} lint:* gate(s) plus build, typecheck and test; ${String(files.length)} workflow(s) can each be started by hand.`)
