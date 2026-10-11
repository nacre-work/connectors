#!/usr/bin/env node
/**
 * The live stack runs the core the kit is written against.
 *
 * `scripts/ci/live.sh` is the gate that watches a connector's three verbs
 * arrive in a real index, and `docker-compose.live.yml` decides which index
 * that is. The kit's SDK decides which core the connectors are written
 * against — the SDK and the core share a version by the core's own release
 * rule. Two numbers, and nothing compared them: the SDK sat at 0.27 while the
 * core shipped fourteen releases, and the gate kept proving the connectors
 * against an index nobody was running any more. The one that mattered was
 * 0.41.0, whose rate limits answer a large first sync with `429` — a gate on
 * 0.27 could not have seen it.
 *
 * So every `ghcr.io/nacre-work/*` image the live stack names carries the
 * version the kit's SDK resolves to, and a file that names none is a refusal,
 * because a check with nothing to hold must not pass.
 */
import { readFileSync } from 'node:fs'

const fail = (message) => {
  console.error(`::error::${message}`)
  process.exit(1)
}

const { version } = JSON.parse(
  readFileSync(new URL('../packages/kit/node_modules/@nacre.work/sdk/package.json', import.meta.url), 'utf8'),
)
const compose = readFileSync(new URL('../docker-compose.live.yml', import.meta.url), 'utf8')
const images = [...compose.matchAll(/ghcr\.io\/nacre-work\/([a-z0-9-]+):([^\s"']+)/g)].map(([, name, tag]) => ({ name, tag }))

if (images.length === 0) fail('docker-compose.live.yml names no ghcr.io/nacre-work image; the live gate would run against no core at all')
const off = images.filter((i) => i.tag !== version)
if (off.length > 0) {
  fail(
    `docker-compose.live.yml runs a core the kit is not written against — the kit's SDK resolves to ${version}:\n  ` +
      off.map((i) => `ghcr.io/nacre-work/${i.name}:${i.tag}`).join('\n  ') +
      `\nMove the images to ${version}, or move packages/kit's @nacre.work/sdk to the core they name.`,
  )
}
console.log(`${String(images.length)} core image(s) in the live stack, all at ${version}, the version the kit's SDK resolves to.`)
