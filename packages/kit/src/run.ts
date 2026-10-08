/**
 * The loop a connector's `main` hands its source and mapping to. Reads the
 * shared configuration, opens the state, serves `/status`, and sweeps on the
 * interval — or once, and exits with the sweep's own verdict, which is what a
 * CI job and a cron line read.
 */
import { NacreClient } from '@nacre.work/sdk'
import { kitConfig, type KitConfig } from './config.js'
import { compileMapping, sweep, type MappingSpec, type Source, type SweepReport } from './engine.js'
import { serve } from './http.js'
import { log, redactUrl } from './log.js'
import { nacreIndex } from './nacre.js'
import { State } from './state.js'
import { StatusBook } from './status.js'

export interface Connector {
  readonly name: string
  readonly version: string
  /** The source's address, for the status and the provenance; credentials are stripped here. */
  readonly source: string
  readonly mapping: MappingSpec
  readonly maxBytes?: number
  /** Built once per process, after the configuration passed. */
  open(config: KitConfig): Promise<Source>
}

export async function runConnector(connector: Connector): Promise<void> {
  const config = kitConfig()
  const mapping = compileMapping(connector.mapping, `${connector.name} mapping`)
  const source = await connector.open(config)
  const state = new State(config.statePath)
  const client = new NacreClient({ baseUrl: config.nacreUrl, token: config.nacreToken })
  const index = nacreIndex(client)
  const provenance = { connector: connector.name, source: redactUrl(connector.source) }
  const book = new StatusBook({ connector: connector.name, version: connector.version, source: provenance.source }, () => ({
    layers: state.layers(),
    documents: state.count(),
  }))
  const server = serve(config.port, book)
  log('connector started', { connector: connector.name, version: connector.version, source: provenance.source, port: config.port, once: config.once })

  const report = {
    skipped: (reason: string, item: string, detail: string) => log('skipped', { reason, item, detail }),
    failed: (verb: string, item: string, detail: string) => log('failed', { verb, item, detail }),
  }
  const once = async (): Promise<SweepReport> => {
    book.begin()
    const r = await sweep({ source, mapping, index, state, provenance, report, ...(connector.maxBytes === undefined ? {} : { maxBytes: connector.maxBytes }) })
    book.end(r)
    log('sweep', {
      sweep: r.sweep,
      complete: r.complete,
      listed: r.listed,
      added: r.added,
      changed: r.changed,
      unchanged: r.unchanged,
      removed: r.removed,
      failed: r.failed,
      skipped: JSON.stringify(r.skipped),
      error: r.error,
    })
    return r
  }

  let stopping = false
  const stop = (): void => {
    stopping = true
    server.close()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  if (config.once) {
    const r = await once()
    state.close()
    server.close()
    // A sweep that could not list the source, or could not get every document
    // the index should have taken, is a failed run — the exit code says so.
    process.exitCode = r.complete && r.failed === 0 ? 0 : 1
    return
  }

  while (!stopping) {
    await once()
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, config.intervalSeconds * 1000)
      const check = setInterval(() => {
        if (stopping) {
          clearTimeout(t)
          clearInterval(check)
          resolve()
        }
      }, 500)
      t.unref()
    })
  }
  state.close()
}
