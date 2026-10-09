/**
 * A Drive folder — or a shared drive — as a source. The listing walks the
 * folder, every subfolder, and builds a path per file (`sub/name`), so the
 * kit's path fields and layer rules apply to a Drive exactly as they do to a
 * repository or a bucket. A file's **`md5Checksum` is its version** where
 * Drive reports one; a Google Doc has none, so its `modifiedTime` and
 * `version` stand in — either moves when the document is edited. A file that
 * is trashed or gone is absent from the listing, and a document absent from a
 * complete listing leaves the index. Drive has no editor-save race: a file
 * missing from a folder was trashed by somebody who meant it, and the trash
 * is still there to take it back.
 *
 * What a file *is* decides how it reaches the index. A Google Doc, Sheet or
 * Slides deck is not a file at all — it has no bytes to download — so it is
 * **exported** as the Word, Excel or PowerPoint file Drive offers, which are
 * three of the formats the index reads, and goes up under that type with the
 * matching extension on its name. The other Google types — forms, drawings,
 * sites, shortcuts — export to nothing the index reads and are skipped as
 * `unmapped`, with the type in the detail. A native file is downloaded: one
 * whose extension or reported type is in the kit's binary table goes up as a
 * file under that type, anything else is read as UTF-8 text and refused as
 * `binary` if it is not — the s3 connector's rule. The listing carries a
 * native file's size, so one over the cap is never downloaded; an export has
 * no size until it is made, so the cap is applied after.
 *
 * The API is behind a port so the source is driven against a tree in a map
 * in the suite and against the stub Drive in the live run; Google's REST API
 * and the signed assertion that opens it sit on the other side of that port,
 * in `google.ts`, and nowhere else.
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

/** One entry of a folder's listing, as `files.list` reports it. */
export interface DriveFile {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly modifiedTime: string | undefined
  /** Native files only; a Google document has no bytes to checksum. */
  readonly md5Checksum: string | undefined
  /** Native files only, in bytes. */
  readonly size: number | undefined
  /** A counter Drive moves on every change to the content. */
  readonly version: string | undefined
}

/** What the source needs of a Drive, and all it needs. */
export interface Drive {
  /** The direct children of a folder — every page of them. A page that fails throws, which ends the sweep without removal. */
  children(folderId: string): AsyncIterable<DriveFile>
  /** A native file's bytes (`alt=media`). */
  download(fileId: string): Promise<Uint8Array>
  /** A Google document's bytes in the format asked for (`files.export`). */
  export(fileId: string, mimeType: string): Promise<Uint8Array>
}

export const FOLDER = 'application/vnd.google-apps.folder'
const GOOGLE_TYPE = /^application\/vnd\.google-apps\./

/**
 * The Google types that export to a format the index reads, and what they
 * export to. The content type is the kit's row for that format, so the
 * declaration cannot drift from what the index accepts.
 */
export const EXPORTS: Readonly<Record<string, { readonly extension: string; readonly contentType: string }>> = {
  'application/vnd.google-apps.document': { extension: 'docx', contentType: contentTypeForExtension('docx') as string },
  'application/vnd.google-apps.spreadsheet': { extension: 'xlsx', contentType: contentTypeForExtension('xlsx') as string },
  'application/vnd.google-apps.presentation': { extension: 'pptx', contentType: contentTypeForExtension('pptx') as string },
}

export interface DriveSourceOptions {
  readonly drive: Drive
  /** The folder walked, or a shared drive's id — the root of every path. */
  readonly folder: string
  readonly include: readonly string[]
  readonly exclude: readonly string[]
  readonly rules: readonly LayerRule[]
  readonly maxBytes: number
}

export class DriveSource implements Source {
  constructor(private readonly o: DriveSourceOptions) {}

  async *list(): AsyncIterable<Item> {
    yield* this.walk(this.o.folder, '', new Set())
  }

  /**
   * Depth first, so a subfolder's failure ends the sweep before the folders
   * beside it are called complete. A folder reached twice — a shortcut is
   * never followed, but Drive's history includes files with several parents
   * — is listed once, or a cycle would be a sweep that never ends.
   */
  private async *walk(folderId: string, prefix: string, seen: Set<string>): AsyncIterable<Item> {
    if (seen.has(folderId)) return
    seen.add(folderId)
    for await (const file of this.o.drive.children(folderId)) {
      if (file.mimeType === FOLDER) {
        yield* this.walk(file.id, `${prefix}${file.name}/`, seen)
        continue
      }
      // A Google document is named after what it exports to, so the path the
      // rules see, the external id and the file the index receives agree on
      // the extension.
      const exported = EXPORTS[file.mimeType]
      const name = exported !== undefined && !file.name.toLowerCase().endsWith(`.${exported.extension}`) ? `${file.name}.${exported.extension}` : file.name
      const path = `${prefix}${name}`
      if (!this.o.include.some((g) => matchesGlob(path, g))) continue
      if (this.o.exclude.some((g) => matchesGlob(path, g))) continue
      const fields: Record<string, unknown> = {
        ...pathFields(path),
        file_id: file.id,
        mime_type: file.mimeType,
        ...(file.size === undefined ? {} : { size: file.size }),
        ...(file.modifiedTime === undefined ? {} : { modified_time: file.modifiedTime }),
        ...(file.md5Checksum === undefined ? {} : { md5: file.md5Checksum }),
      }
      // The layer is decided here, from the listing's fields, so an unchanged
      // checksum never costs a download; a file no rule matches is counted
      // rather than guessed into a layer.
      const rule = this.o.rules.find((r) => matchesGlob(path, r.glob))
      if (rule === undefined) {
        yield { id: file.id, fields: { ...fields, skip: 'unmapped', skip_detail: 'no layer rule matches' } }
        continue
      }
      if (exported === undefined && GOOGLE_TYPE.test(file.mimeType)) {
        yield { id: file.id, fields: { ...fields, skip: 'unmapped', skip_detail: `${file.mimeType} exports to nothing the index reads` } }
        continue
      }
      fields['layer'] = rule.layer.render(fields)
      const version = versionOf(file)
      yield { id: file.id, ...(version === undefined ? {} : { version }), fields }
    }
  }

  async fetch(item: Item): Promise<Fields> {
    if (typeof item.fields['skip'] === 'string') return {}
    const mimeType = String(item.fields['mime_type'] ?? '')

    const exported = EXPORTS[mimeType]
    if (exported !== undefined) {
      const bytes = await this.o.drive.export(item.id, exported.contentType)
      // After the export, because there was no size to ask before it.
      if (bytes.byteLength > this.o.maxBytes) {
        return { skip: 'oversize', skip_detail: `${String(bytes.byteLength)} bytes once exported, DRIVE_MAX_BYTES is ${String(this.o.maxBytes)}` }
      }
      return { bytes, content_type: exported.contentType }
    }

    const size = Number(item.fields['size'] ?? 0)
    // Before the download, because the listing already said how big it is.
    if (size > this.o.maxBytes) return { skip: 'oversize', skip_detail: `${String(size)} bytes, DRIVE_MAX_BYTES is ${String(this.o.maxBytes)}` }

    const bytes = await this.o.drive.download(item.id)
    const binaryType = contentTypeForExtension(String(item.fields['ext'] ?? '')) ?? binaryContentType(mimeType)
    if (binaryType !== undefined) return { bytes, content_type: binaryType }

    try {
      return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    } catch {
      return { skip: 'binary', skip_detail: `not UTF-8 text and not a format the index reads (${mimeType || 'no mime type'})` }
    }
  }
}

/**
 * The cheap path's key: the checksum where Drive computed one, and for a
 * Google document — which has none — the time and the counter together, since
 * a `version` alone is per file and a time alone has a resolution.
 */
export function versionOf(file: DriveFile): string | undefined {
  if (file.md5Checksum !== undefined && file.md5Checksum !== '') return file.md5Checksum
  if (file.modifiedTime === undefined && file.version === undefined) return undefined
  return `${file.modifiedTime ?? ''}#${file.version ?? ''}`
}
