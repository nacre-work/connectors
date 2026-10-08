/**
 * A bucket as a source. The listing is every object under a prefix, an
 * object's **ETag is its version** — so a sweep over a bucket of a hundred
 * thousand objects downloads exactly the ones that changed — and a key that
 * left the listing is a document that leaves the index. An object store has
 * no editor-save race: a key absent from a complete listing was deleted by
 * somebody who meant it.
 *
 * What an object *is* decides how it reaches the index. A key whose extension
 * is in the kit's binary table goes up as a file under that type — the index
 * is told the type and never sniffs — and so does an object whose own
 * `Content-Type` is in the table; anything else is read as UTF-8 text, and
 * refused as `binary` if it is not. The size is known from the listing, so an
 * object over the cap is never downloaded at all.
 *
 * The store is behind a port so the source is driven against a map in the
 * suite and against a real bucket — MinIO in CI — in the live run; the AWS
 * SDK sits on the other side of that port and nowhere else.
 */
import {
  binaryContentType,
  contentTypeForExtension,
  matchesGlob,
  pathFields,
  type Fields,
  type Item,
  type LayerRule,
  type Source,
} from '@nacre.work/connector-kit'

export interface StoredObject {
  readonly key: string
  readonly etag: string
  readonly size: number
  readonly lastModified: Date | undefined
}

/** What the source needs of a bucket, and all it needs. */
export interface ObjectStore {
  list(prefix: string): AsyncIterable<StoredObject>
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string | undefined }>
}

export interface S3SourceOptions {
  readonly store: ObjectStore
  /** Listed under this; stripped from the path the rules and fields see. */
  readonly prefix: string
  readonly include: readonly string[]
  readonly exclude: readonly string[]
  readonly rules: readonly LayerRule[]
  readonly maxBytes: number
}

export class S3Source implements Source {
  constructor(private readonly o: S3SourceOptions) {}

  async *list(): AsyncIterable<Item> {
    for await (const object of this.o.store.list(this.o.prefix)) {
      // A "folder" placeholder some consoles write; it has no content.
      if (object.key.endsWith('/')) continue
      const path = object.key.startsWith(this.o.prefix) ? object.key.slice(this.o.prefix.length).replace(/^\/+/, '') : object.key
      if (path === '') continue
      if (!this.o.include.some((g) => matchesGlob(path, g))) continue
      if (this.o.exclude.some((g) => matchesGlob(path, g))) continue
      const fields: Record<string, unknown> = {
        ...pathFields(path),
        key: object.key,
        size: object.size,
        etag: object.etag,
        ...(object.lastModified === undefined ? {} : { last_modified: object.lastModified.toISOString() }),
      }
      // The layer is decided here, from the listing's fields, so an unchanged
      // ETag never costs a download; a key no rule matches is counted rather
      // than guessed into a layer.
      const rule = this.o.rules.find((r) => matchesGlob(path, r.glob))
      if (rule === undefined) {
        yield { id: object.key, fields: { ...fields, skip: 'unmapped', skip_detail: 'no layer rule matches' } }
        continue
      }
      fields['layer'] = rule.layer.render(fields)
      yield { id: object.key, version: object.etag, fields }
    }
  }

  async fetch(item: Item): Promise<Fields> {
    if (typeof item.fields['skip'] === 'string') return {}
    const size = Number(item.fields['size'])
    // Before the download, because the listing already said how big it is.
    if (size > this.o.maxBytes) return { skip: 'oversize', skip_detail: `${String(size)} bytes, S3_MAX_BYTES is ${String(this.o.maxBytes)}` }

    const { bytes, contentType } = await this.o.store.get(item.id)
    const declared = contentType?.split(';')[0]?.trim().toLowerCase()
    const binaryType = contentTypeForExtension(String(item.fields['ext'] ?? '')) ?? (declared === undefined ? undefined : binaryContentType(declared))
    if (binaryType !== undefined) return { bytes, content_type: binaryType }

    try {
      return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    } catch {
      return { skip: 'binary', skip_detail: `not UTF-8 text and not a format the index reads (${declared ?? 'no content type'})` }
    }
  }
}
