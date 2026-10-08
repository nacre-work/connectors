/**
 * What a connector says about itself, on `/status` and `/metrics`.
 *
 * `contract: 1` is a promise: the keys here are read by things this
 * repository does not know about — a dashboard, if one is ever built, lives
 * elsewhere and polls this. A key is added by raising the number, never
 * renamed or removed under it. The metrics are the same promise in
 * Prometheus's shape, prefixed `nacre_connector_`.
 */
import type { SweepReport } from './engine.js'

export const STATUS_CONTRACT = 1

export interface Status {
  readonly contract: typeof STATUS_CONTRACT
  readonly connector: string
  readonly version: string
  /** The source, with any credential stripped. */
  readonly source: string
  readonly layers: readonly string[]
  readonly documents: number
  readonly running: boolean
  readonly sweep: SweepReport | null
  readonly sweeps: { readonly complete: number; readonly incomplete: number }
  readonly totals: {
    readonly added: number
    readonly changed: number
    readonly unchanged: number
    readonly removed: number
    readonly failed: number
    readonly skipped: Readonly<Record<string, number>>
  }
}

export class StatusBook {
  #last: SweepReport | null = null
  #running = false
  #complete = 0
  #incomplete = 0
  readonly #totals = { added: 0, changed: 0, unchanged: 0, removed: 0, failed: 0, skipped: {} as Record<string, number> }

  constructor(
    private readonly meta: { connector: string; version: string; source: string },
    private readonly read: () => { layers: readonly string[]; documents: number },
  ) {}

  begin(): void {
    this.#running = true
  }

  end(report: SweepReport): void {
    this.#running = false
    this.#last = report
    if (report.complete) this.#complete += 1
    else this.#incomplete += 1
    this.#totals.added += report.added
    this.#totals.changed += report.changed
    this.#totals.unchanged += report.unchanged
    this.#totals.removed += report.removed
    this.#totals.failed += report.failed
    for (const [reason, n] of Object.entries(report.skipped)) {
      this.#totals.skipped[reason] = (this.#totals.skipped[reason] ?? 0) + n
    }
  }

  status(): Status {
    const { layers, documents } = this.read()
    return {
      contract: STATUS_CONTRACT,
      connector: this.meta.connector,
      version: this.meta.version,
      source: this.meta.source,
      layers,
      documents,
      running: this.#running,
      sweep: this.#last,
      sweeps: { complete: this.#complete, incomplete: this.#incomplete },
      totals: { ...this.#totals, skipped: { ...this.#totals.skipped } },
    }
  }

  /** Prometheus text exposition, written by hand: four counters and three gauges need no client library. */
  metrics(): string {
    const s = this.status()
    const labels = `connector="${s.connector}"`
    const lines: string[] = []
    const counter = (name: string, help: string, rows: readonly [string, number][]): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`)
      for (const [extra, value] of rows) lines.push(`${name}{${labels}${extra}} ${String(value)}`)
    }
    const gauge = (name: string, help: string, value: number): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}{${labels}} ${String(value)}`)
    }
    counter('nacre_connector_sweeps_total', 'Sweeps, by whether the listing completed.', [
      [',result="complete"', s.sweeps.complete],
      [',result="incomplete"', s.sweeps.incomplete],
    ])
    counter('nacre_connector_documents_total', 'Documents by what the sweep did with them.', [
      [',verb="added"', s.totals.added],
      [',verb="changed"', s.totals.changed],
      [',verb="unchanged"', s.totals.unchanged],
      [',verb="removed"', s.totals.removed],
      [',verb="failed"', s.totals.failed],
    ])
    counter(
      'nacre_connector_skipped_total',
      'Items listed and not sent, by reason.',
      Object.entries(s.totals.skipped).map(([reason, n]) => [`,reason="${reason}"`, n] as [string, number]),
    )
    gauge('nacre_connector_state_documents', 'Documents the state remembers as indexed.', s.documents)
    gauge('nacre_connector_running', '1 while a sweep is in progress.', s.running ? 1 : 0)
    if (s.sweep !== null) {
      const seconds = (Date.parse(s.sweep.finishedAt) - Date.parse(s.sweep.startedAt)) / 1000
      gauge('nacre_connector_last_sweep_duration_seconds', 'Wall-clock length of the last sweep.', seconds)
      gauge('nacre_connector_last_sweep_complete', '1 if the last listing ended normally.', s.sweep.complete ? 1 : 0)
    }
    return `${lines.join('\n')}\n`
  }
}
