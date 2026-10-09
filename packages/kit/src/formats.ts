/**
 * The binary formats the index accepts, as a connector needs them: a file's
 * extension to the type the index must be told. The index refuses to sniff —
 * the part declares the type and the bytes must carry its signature — so a
 * connector that lists files has to decide the declaration from what it
 * knows, which is the key or the name.
 *
 * This is a copy of `packages/core/formats.ts` in the core, row for row, and
 * a copy is only safe while something compares the copies: `lint:formats`
 * fetches the core's file at the version the kit's SDK resolves to — the SDK
 * and the core share a version by the core's release rule — and holds every
 * row of this table against it, both directions. A row the index would refuse
 * is a document rejected on every sweep; a row this table lacks is a file
 * skipped as binary that the index would have read.
 *
 * One entry per line, in the core's shape, because that is what the check
 * parses on both sides.
 */

export interface BinaryFormat {
  readonly contentType: string
  readonly format: string
  readonly family: 'pdf' | 'zip' | 'rtf'
  readonly extension: string
}

export const BINARY_FORMATS: readonly BinaryFormat[] = [
  { contentType: 'application/pdf', format: 'pdf', family: 'pdf', extension: 'pdf' },
  { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', format: 'docx', family: 'zip', extension: 'docx' },
  { contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', format: 'pptx', family: 'zip', extension: 'pptx' },
  { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', format: 'xlsx', family: 'zip', extension: 'xlsx' },
  { contentType: 'application/vnd.oasis.opendocument.text', format: 'odt', family: 'zip', extension: 'odt' },
  { contentType: 'application/vnd.oasis.opendocument.presentation', format: 'odp', family: 'zip', extension: 'odp' },
  { contentType: 'application/vnd.oasis.opendocument.spreadsheet', format: 'ods', family: 'zip', extension: 'ods' },
  { contentType: 'application/epub+zip', format: 'epub', family: 'zip', extension: 'epub' },
  { contentType: 'application/rtf', format: 'rtf', family: 'rtf', extension: 'rtf' },
]

/** The type to declare for a file named with this extension, or `undefined` for one the index does not read as binary. */
export function contentTypeForExtension(extension: string): string | undefined {
  const ext = extension.replace(/^\./, '').toLowerCase()
  return BINARY_FORMATS.find((f) => f.extension === ext)?.contentType
}

/**
 * A second spelling the index admits, mapped to the one it stores — the
 * core's `ALIASES`, held by the same check.
 */
const ALIASES: Readonly<Record<string, string>> = {
  'text/rtf': 'application/rtf',
}

/**
 * The type the index should be told for a declared one — as an object store
 * or a mail part reports it — or `undefined` for a type the index does not
 * read as binary. Canonical, so an alias is sent as the row it names.
 */
export function binaryContentType(declared: string): string | undefined {
  const type = declared.split(';')[0]?.trim().toLowerCase() ?? ''
  const canonical = ALIASES[type] ?? type
  return BINARY_FORMATS.find((f) => f.contentType === canonical)?.contentType
}

/** Whether a declared type is one the index reads as binary. */
export function isBinaryContentType(declared: string): boolean {
  return binaryContentType(declared) !== undefined
}
