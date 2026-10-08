/**
 * The sync: one full listing of the source, three verbs against the index.
 *
 * **Add** and **change** are the easy half, because ingest is idempotent on
 * `(layer, external_id)` plus the content hash: everything the source offers
 * is mapped, hashed, and sent only when the hash moved. **Remove** is the
 * whole reason the state exists — the index cannot know the source dropped
 * something, so the engine compares what a *complete* listing contained with
 * what it remembered, and removes the difference. A listing that did not
 * complete removes nothing; see `State.unseen`.
 *
 * The index is behind a four-method port so the engine is driven against a
 * fake in the suite and against the real SDK in the connector. The fake is
 * for the engine's own arithmetic; what the real index does with a request is
 * measured in the live run, where a connector's three verbs are checked by
 * searching.
 */
import { createHash } from 'node:crypto'
import { compile, MissingField, type Fields, type Template } from './expression.js'
import type { State } from './state.js'

/** One thing the source offers: an identity, a cheap version when it has one, and its fields. */
export interface Item {
  readonly id: string
  /** Something that changes when the content changes — a blob hash, an ETag, an updated_at. Lets an unchanged item skip its fetch. */
  readonly version?: string
  readonly fields: Fields
}

export interface Source {
  /** A complete listing. Ending normally is what licenses removal; throwing does not. */
  list(): AsyncIterable<Item>
  /** The expensive part — fields the listing did not carry, the content among them. */
  fetch(item: Item): Promise<Fields>
}

export type MetadataValue = string | number | boolean | readonly (string | number | boolean)[]

export interface Mapped {
  readonly layer: string
  readonly externalId: string
  readonly title: string | undefined
  readonly content: string
  readonly metadata: Readonly<Record<string, MetadataValue>>
}

export interface MappingSpec {
  readonly layer: string
  readonly externalId: string
  readonly title?: string
  readonly content: string
  readonly metadata?: Readonly<Record<string, string>>
}

export interface Mapping {
  readonly layer: Template
  readonly externalId: Template
  readonly title: Template | undefined
  readonly content: Template
  readonly metadata: Readonly<Record<string, Template>>
  /** Every field any template reads. */
  readonly fields: readonly string[]
}

const METADATA_KEY = /^[a-z][a-z0-9_]{0,63}$/

export function compileMapping(spec: MappingSpec, where = 'mapping'): Mapping {
  const metadata: Record<string, Template> = {}
  for (const [key, source] of Object.entries(spec.metadata ?? {})) {
    if (!METADATA_KEY.test(key)) {
      throw new Error(`${where}: metadata key ${JSON.stringify(key)} must be lower-case letters, digits and underscores`)
    }
    metadata[key] = compile(source, `${where}.metadata.${key}`)
  }
  const layer = compile(spec.layer, `${where}.layer`)
  const externalId = compile(spec.externalId, `${where}.external_id`)
  const title = spec.title === undefined ? undefined : compile(spec.title, `${where}.title`)
  const content = compile(spec.content, `${where}.content`)
  const fields = [...new Set([layer, externalId, title, content, ...Object.values(metadata)].flatMap((t) => t?.fields ?? []))]
  return { layer, externalId, title, content, metadata, fields }
}

export interface Index {
  add(doc: Mapped): Promise<{ documentId: string; unchanged: boolean }>
  /** `false` when the index no longer has it, which is the outcome wanted either way. */
  remove(documentId: string): Promise<boolean>
}

/** How the index refused one document, as the engine classifies it. */
export class IndexRefusal extends Error {
  override readonly name = 'IndexRefusal'
  constructor(
    readonly reason: 'layer_missing' | 'rejected',
    message: string,
  ) {
    super(message)
  }
}

export type SkipReason = 'layer_missing' | 'rejected' | 'missing_field' | 'empty' | 'oversize' | 'binary' | 'unmapped'

export interface SweepReport {
  readonly sweep: number
  readonly startedAt: string
  readonly finishedAt: string
  /** The listing ended normally, so removal ran. */
  readonly complete: boolean
  readonly listed: number
  readonly added: number
  readonly changed: number
  readonly unchanged: number
  readonly removed: number
  readonly skipped: Readonly<Record<string, number>>
  /** Adds and removes the index could not take this time; retried next sweep. */
  readonly failed: number
  readonly error: string | undefined
}

export interface Reporter {
  skipped(reason: SkipReason, item: string, detail: string): void
  failed(verb: 'add' | 'remove', item: string, detail: string): void
}

/** Fixed metadata every document carries, merged under the mapping's own. */
export interface Provenance {
  readonly connector: string
  readonly source: string
}

export interface SweepOptions {
  readonly source: Source
  readonly mapping: Mapping
  readonly index: Index
  readonly state: State
  readonly provenance: Provenance
  readonly report: Reporter
  readonly now?: () => Date
  /** A source may carry a `skip` field naming a reason the engine should count rather than map. */
  readonly maxBytes?: number
}

export async function sweep(options: SweepOptions): Promise<SweepReport> {
  const now = options.now ?? (() => new Date())
  const { source, mapping, index, state, report } = options
  const id = state.beginSweep(now())
  const startedAt = now().toISOString()
  const skipped: Record<string, number> = {}
  const skip = (reason: SkipReason, item: string, detail: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
    report.skipped(reason, item, detail)
  }
  let listed = 0
  let added = 0
  let changed = 0
  let unchanged = 0
  let removed = 0
  let failed = 0
  let complete = false
  let error: string | undefined

  try {
    for await (const item of source.list()) {
      listed += 1
      // Where a cheap version is offered and the row remembers it, the fetch
      // and the hash are both skipped: a git tree lists thousands of blobs and
      // reads none that did not move.
      const remembered = item.version === undefined ? undefined : rememberedByVersion(state, mapping, item)
      if (remembered !== undefined) {
        state.markSeen(id, remembered.layer, remembered.externalId)
        unchanged += 1
        continue
      }

      let mapped: Mapped
      try {
        const fetched = await source.fetch(item)
        const fields = { ...item.fields, ...fetched }
        if (typeof fields['skip'] === 'string') {
          skip(fields['skip'] as SkipReason, item.id, String(fields['skip_detail'] ?? ''))
          continue
        }
        mapped = render(mapping, fields, options.provenance)
      } catch (e) {
        if (e instanceof MissingField) {
          skip('missing_field', item.id, e.field)
          continue
        }
        throw e
      }
      if (mapped.content.trim() === '') {
        skip('empty', item.id, 'the mapped content is empty')
        continue
      }
      if (options.maxBytes !== undefined && Buffer.byteLength(mapped.content) > options.maxBytes) {
        skip('oversize', item.id, `${String(Buffer.byteLength(mapped.content))} bytes`)
        continue
      }

      const hash = contentHash(mapped)
      const row = state.get(mapped.layer, mapped.externalId)
      if (row !== undefined && row.contentHash === hash) {
        state.upsert(id, { ...row, sourceVersion: item.version ?? null })
        unchanged += 1
        continue
      }
      // Listed, whatever the index says next: a changed document the index
      // refuses this sweep is still in the source and must not be removed.
      if (row !== undefined) state.markSeen(id, row.layer, row.externalId)
      try {
        const outcome = await index.add(mapped)
        state.upsert(id, {
          layer: mapped.layer,
          externalId: mapped.externalId,
          documentId: outcome.documentId,
          contentHash: hash,
          sourceVersion: item.version ?? null,
        })
        if (row === undefined) added += 1
        else changed += 1
      } catch (e) {
        if (e instanceof IndexRefusal) {
          skip(e.reason, item.id, e.message)
          continue
        }
        failed += 1
        report.failed('add', item.id, e instanceof Error ? e.message : String(e))
      }
    }
    complete = true
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (complete) {
    state.finishSweep(id, now())
    for (const row of state.unseen(id)) {
      try {
        await index.remove(row.documentId)
        state.remove(row.layer, row.externalId)
        removed += 1
      } catch (e) {
        failed += 1
        report.failed('remove', `${row.layer}/${row.externalId}`, e instanceof Error ? e.message : String(e))
      }
    }
  }

  return {
    sweep: id,
    startedAt,
    finishedAt: now().toISOString(),
    complete,
    listed,
    added,
    changed,
    unchanged,
    removed,
    skipped,
    failed,
    error,
  }
}

/**
 * The row for an item whose version has not moved — found by rendering only
 * the layer and the external id, which a source's listing fields must be able
 * to produce. A template that needs a fetched field for either of those
 * disables the cheap path rather than breaking it.
 */
function rememberedByVersion(state: State, mapping: Mapping, item: Item) {
  try {
    const layer = mapping.layer.render(item.fields)
    const externalId = mapping.externalId.render(item.fields)
    const row = state.get(layer, externalId)
    return row !== undefined && row.sourceVersion === item.version ? row : undefined
  } catch (e) {
    if (e instanceof MissingField) return undefined
    throw e
  }
}

function render(mapping: Mapping, fields: Fields, provenance: Provenance): Mapped {
  const metadata: Record<string, MetadataValue> = { connector: provenance.connector, source: provenance.source }
  for (const [key, template] of Object.entries(mapping.metadata)) metadata[key] = template.render(fields)
  return {
    layer: mapping.layer.render(fields),
    externalId: mapping.externalId.render(fields),
    title: mapping.title?.render(fields),
    content: mapping.content.render(fields),
    metadata,
  }
}

/** Over everything the index is sent, so a title or a tag changing re-sends. */
export function contentHash(doc: Mapped): string {
  const h = createHash('sha256')
  h.update(JSON.stringify([doc.layer, doc.externalId, doc.title ?? null, doc.content, doc.metadata]))
  return h.digest('hex')
}
