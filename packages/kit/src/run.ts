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

/** How long a one-shot run waits for a leaked handle before it exits anyway. */
export const LEAK_GRACE_MS = 5_000

/**
 * A one-shot run that did everything the index had room for and held the
 * rest back: sysexits' `EX_TEMPFAIL`, "try again later". Not `0`, because the
 * index is not yet what the source says and a job reading the code must not
 * be told it is; not `1`, because nothing is wrong and a job that pages on
 * failure must not be woken by an index working as configured.
 */
export const EXIT_DEFERRED = 75

/** A one-shot run's exit code, from its sweep. */
export function verdict(r: Pick<SweepReport, 'complete' | 'failed' | 'deferred'>): number {
  if (!r.complete || r.failed > 0) return 1
  return r.deferred > 0 ? EXIT_DEFERRED : 0
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
    paused: (verb: string, item: string, retryAfterSeconds: number | undefined, detail: string) =>
      log('paused', { verb, item, retry_after_seconds: retryAfterSeconds, detail }),
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
      deferred: r.deferred,
      resume_at: r.resumeAt ?? undefined,
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
    // One the index asked to wait is neither a success nor that; see `verdict`.
    process.exitCode = verdict(r)
    // The process ends when the loop drains, and a source that leaves a
    // handle open — a driver's pool, a monitor timer — keeps it from
    // draining: the verdict is set and nothing reads it, because nothing
    // exits. The mongo connector did exactly that, for thirty minutes of a
    // CI job, with the sweep long done. So a one-shot run says what it is
    // waiting on and leaves, with the verdict it already reached. Unref'd,
    // so the timer itself is not what keeps the loop alive.
    setTimeout(() => {
      log('exiting with handles still open', { connector: connector.name, detail: 'the source left a connection or a timer open after the sweep; close it in list()', exit: process.exitCode })
      process.exit(process.exitCode)
    }, LEAK_GRACE_MS).unref()
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
