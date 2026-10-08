/**
 * What the connector remembers between sweeps, in one SQLite file in a volume.
 * `node:sqlite` is built into Node, so the state costs no dependency.
 *
 * The one property that matters is about deletion. A document is removed from
 * the index when a **complete** listing of the source did not contain it —
 * and only then. A listing that stops halfway, for any reason, marks nothing
 * for removal: the unseen half would otherwise be "removed from the source"
 * when it was merely not reached. So `finishSweep` is called only after the
 * source's iterator ended, and `unseen` is asked only of a finished sweep.
 */
import { DatabaseSync } from 'node:sqlite'

export interface DocumentRow {
  readonly layer: string
  readonly externalId: string
  readonly documentId: string
  readonly contentHash: string
  readonly sourceVersion: string | null
}

export class State {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS documents (
        layer          TEXT NOT NULL,
        external_id    TEXT NOT NULL,
        document_id    TEXT NOT NULL,
        content_hash   TEXT NOT NULL,
        source_version TEXT,
        seen_sweep     INTEGER NOT NULL,
        PRIMARY KEY (layer, external_id)
      );
      CREATE TABLE IF NOT EXISTS sweeps (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        complete    INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS cursors (
        name  TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }

  beginSweep(now: Date): number {
    const r = this.#db.prepare(`INSERT INTO sweeps (started_at) VALUES (?)`).run(now.toISOString())
    return Number(r.lastInsertRowid)
  }

  /** Only after the listing ended. A sweep never finished is one whose unseen rows are never asked for. */
  finishSweep(id: number, now: Date): void {
    this.#db.prepare(`UPDATE sweeps SET finished_at = ?, complete = 1 WHERE id = ?`).run(now.toISOString(), id)
  }

  get(layer: string, externalId: string): DocumentRow | undefined {
    const row = this.#db
      .prepare(`SELECT layer, external_id, document_id, content_hash, source_version FROM documents WHERE layer = ? AND external_id = ?`)
      .get(layer, externalId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : fromRow(row)
  }

  /** Listed this sweep, whatever happened to its add. */
  markSeen(sweep: number, layer: string, externalId: string): void {
    this.#db.prepare(`UPDATE documents SET seen_sweep = ? WHERE layer = ? AND external_id = ?`).run(sweep, layer, externalId)
  }

  upsert(sweep: number, row: DocumentRow): void {
    this.#db
      .prepare(
        `INSERT INTO documents (layer, external_id, document_id, content_hash, source_version, seen_sweep)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (layer, external_id) DO UPDATE SET
           document_id = excluded.document_id, content_hash = excluded.content_hash,
           source_version = excluded.source_version, seen_sweep = excluded.seen_sweep`,
      )
      .run(row.layer, row.externalId, row.documentId, row.contentHash, row.sourceVersion, sweep)
  }

  remove(layer: string, externalId: string): void {
    this.#db.prepare(`DELETE FROM documents WHERE layer = ? AND external_id = ?`).run(layer, externalId)
  }

  /** Rows a finished sweep did not list. Refuses an unfinished one rather than guessing. */
  unseen(sweep: number): readonly DocumentRow[] {
    const s = this.#db.prepare(`SELECT complete FROM sweeps WHERE id = ?`).get(sweep) as { complete: number } | undefined
    if (s === undefined || s.complete !== 1) {
      throw new Error(`sweep ${String(sweep)} did not finish; nothing it did not list can be called removed`)
    }
    const rows = this.#db
      .prepare(`SELECT layer, external_id, document_id, content_hash, source_version FROM documents WHERE seen_sweep < ?`)
      .all(sweep) as Record<string, unknown>[]
    return rows.map(fromRow)
  }

  count(): number {
    const r = this.#db.prepare(`SELECT count(*) AS n FROM documents`).get() as { n: number }
    return Number(r.n)
  }

  layers(): readonly string[] {
    const rows = this.#db.prepare(`SELECT DISTINCT layer FROM documents ORDER BY layer`).all() as { layer: string }[]
    return rows.map((r) => r.layer)
  }

  cursor(name: string): string | undefined {
    const r = this.#db.prepare(`SELECT value FROM cursors WHERE name = ?`).get(name) as { value: string } | undefined
    return r?.value
  }

  setCursor(name: string, value: string): void {
    this.#db.prepare(`INSERT INTO cursors (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value`).run(name, value)
  }

  close(): void {
    this.#db.close()
  }
}

function fromRow(r: Record<string, unknown>): DocumentRow {
  return {
    layer: String(r.layer),
    externalId: String(r.external_id),
    documentId: String(r.document_id),
    contentHash: String(r.content_hash),
    sourceVersion: r.source_version === null || r.source_version === undefined ? null : String(r.source_version),
  }
}
