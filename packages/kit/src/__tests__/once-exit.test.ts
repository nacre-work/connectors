/**
 * A one-shot run ends, whatever its source left open.
 *
 * In a child process rather than in-process: `runConnector` serves a port,
 * reads the environment and calls `process.exit`, none of which belongs in
 * the runner. The source here lists nothing and leaves an interval behind —
 * the shape of a driver pool nobody closed — and the claim is that the
 * process still exits, inside the grace period, with the sweep's verdict and
 * a line saying why it had to be forced.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LEAK_GRACE_MS } from '../run.js'

const dist = fileURLToPath(new URL('../../dist/index.js', import.meta.url))

describe('a one-shot run with a leaked handle', () => {
  it('exits inside the grace period, saying so', async () => {
    // A stand-in API: the sweep lists nothing, so the only call is the one
    // `nacreIndex` may make to look around; every answer is an empty page.
    const api = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ items: [], next_cursor: null }))
    })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
    const port = (api.address() as { port: number }).port
    // A free port for the connector's own /status, since the kit refuses 0.
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const free = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const dir = mkdtempSync(join(tmpdir(), 'kit-once-'))
    const script = join(dir, 'leaky.mjs')
    writeFileSync(
      script,
      `import { runConnector } from ${JSON.stringify(dist)}
await runConnector({
  name: 'leaky', version: '0', source: 'leak://nowhere',
  mapping: { layer: 'x', externalId: '\${id}', content: '\${id}' },
  async open() {
    setInterval(() => {}, 60_000) // the handle a driver pool is
    return { async *list() {}, async fetch() { return {} } }
  },
})
`,
    )
    const started = Date.now()
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        NACRE_URL: `http://127.0.0.1:${String(port)}`,
        NACRE_TOKEN: 'x',
        CONNECTOR_STATE: join(dir, 'state.sqlite'),
        SYNC_ONCE: 'true',
        PORT: String(free),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
    api.close()
    const took = Date.now() - started
    expect(code, out).toBe(0)
    expect(out).toContain('exiting with handles still open')
    expect(took).toBeLessThan(LEAK_GRACE_MS + 10_000)
  }, 30_000)
})
