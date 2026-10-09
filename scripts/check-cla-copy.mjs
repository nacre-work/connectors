#!/usr/bin/env node
/**
 * The contributor agreement here is the core's, and nothing about it drifts.
 *
 * Three things in this repository are copies of nacre-work/nacre, across a
 * boundary no import can cross, so this is the thing that knows there are two:
 *
 * - `CLA.md`, byte for byte. A signer here agrees to "the Nacre Contributor
 *   License Agreement version 1.0", and that sentence has to name one
 *   document. Two texts under one version number is two agreements with
 *   nothing saying which one somebody signed.
 * - `.github/scripts/check-cla.mjs`, byte for byte. The gate decides who may
 *   merge; a fix to it in one repository and not the other is the most
 *   repeated defect the core records.
 * - The `owners` and `claVersion` of `.github/cla/signatures.json`. The
 *   counterparty is one person in both places, and a version bump there is a
 *   version bump here — the gate treats a signature against an older version
 *   as none, which only means something if both lists move together.
 *
 * Read from the core's `main`, because the agreement is not released with the
 * code: it changes by a pull request to that branch and applies from then on.
 * A fetch that fails is a failure and never a pass.
 *
 * Two more, about this repository only: the version the signature list
 * carries is the one CLA.md states — the core's list says so in a comment and
 * nothing holds it — and the workflow actually runs the script, since a copy
 * nothing invokes is a gate that reports green having asked nobody. The
 * NOTICE is held too: CLA.md's definition of the Owner names "the LICENSE and
 * NOTICE files of this repository", and a sentence about a file that is not
 * there is the agreement describing a different repository.
 */
import { existsSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'

const CORE = 'https://raw.githubusercontent.com/nacre-work/nacre/main'
const problems = []
const fail = (m) => problems.push(m)

async function core(path) {
  const url = `${CORE}/${path}`
  let response
  try {
    response = await fetch(url)
  } catch (e) {
    console.error(`::error::could not fetch ${url}: ${e instanceof Error ? e.message : String(e)}; a check that cannot read must not pass`)
    process.exit(1)
  }
  if (!response.ok) {
    console.error(`::error::${url} answered ${String(response.status)}; a check that cannot read must not pass`)
    process.exit(1)
  }
  return response.text()
}

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

for (const path of ['CLA.md', '.github/scripts/check-cla.mjs']) {
  const ours = read(path)
  if (ours === undefined) {
    fail(`${path} is missing`)
    continue
  }
  if (ours !== (await core(path))) fail(`${path} differs from nacre-work/nacre@main — copy it across: the two must be one document`)
}

const listPath = '.github/cla/signatures.json'
const ourList = JSON.parse(read(listPath) ?? 'null')
const coreList = JSON.parse(await core(listPath))
if (ourList === null) fail(`${listPath} is missing`)
else {
  if (ourList.claVersion !== coreList.claVersion) fail(`${listPath}: claVersion ${String(ourList.claVersion)}, the core's is ${String(coreList.claVersion)}`)
  if (!isDeepStrictEqual(ourList.owners, coreList.owners)) fail(`${listPath}: owners differ from the core's — the counterparty is one person in both repositories`)
  const stated = /^\*\*Version ([0-9.]+)\*\*/m.exec(read('CLA.md') ?? '')?.[1]
  if (stated === undefined) fail('CLA.md: no "**Version X**" line, so nothing says which version a signature is against')
  else if (ourList.claVersion !== stated) fail(`${listPath}: claVersion ${String(ourList.claVersion)}, CLA.md says ${stated}`)
}

const workflow = read('.github/workflows/cla.yml')
if (workflow === undefined) fail('.github/workflows/cla.yml is missing: the agreement is stated and nothing enforces it')
else if (!workflow.includes('node .github/scripts/check-cla.mjs')) fail('.github/workflows/cla.yml does not run .github/scripts/check-cla.mjs')

const notice = read('NOTICE')
if (notice === undefined || !notice.includes('Nacre')) fail('NOTICE is missing or does not name Nacre, and CLA.md defines the Owner by the LICENSE and NOTICE files of this repository')

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`)
  process.exit(1)
}
console.log(`CLA.md and the gate are the core's, byte for byte; owners and version ${String(ourList.claVersion)} agree; cla.yml runs the gate.`)
