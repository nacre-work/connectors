import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileMapping, parseLayerRules, State, sweep, type Index, type Mapped } from '@nacre.work/connector-kit'
import { describe, expect, it } from 'vitest'
import { loadServiceAccountKey } from '../google.js'
import { DriveSource, EXPORTS, FOLDER, type Drive, type DriveFile } from '../source.js'

const GOOGLE_DOC = 'application/vnd.google-apps.document'
const GOOGLE_FORM = 'application/vnd.google-apps.form'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

type Entry = { readonly bytes: Uint8Array; readonly mimeType: string; readonly modified: string; readonly version: number }

/**
 * A Drive in a map: paths to entries, folders implied by the paths, ids
 * derived from the paths so they are stable across sweeps — which is what
 * lets the suite edit the tree between sweeps and watch the verbs. A
 * download and an export each count, and a folder can be made to fail its
 * listing.
 */
class MemoryDrive implements Drive {
  readonly entries = new Map<string, Entry>()
  readonly downloads: string[] = []
  readonly exports: string[] = []
  /** The folder whose listing throws, if any. */
  failing: string | undefined
  put(path: string, body: string | Uint8Array, mimeType = 'application/octet-stream') {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
    const before = this.entries.get(path)
    this.entries.set(path, { bytes, mimeType, modified: `2026-01-0${String((before?.version ?? 0) + 1)}T00:00:00Z`, version: (before?.version ?? 0) + 1 })
  }
  /** A Google document: what it exports to, since it has no bytes of its own. */
  putDoc(path: string, exported: string | Uint8Array, mimeType = GOOGLE_DOC) {
    this.put(path, exported, mimeType)
  }
  async *children(folderId: string): AsyncIterable<DriveFile> {
    const dir = folderId === 'root' ? '' : decode(folderId)
    if (this.failing === dir) throw new Error(`the listing of ${dir} answered 503`)
    const folders = new Set<string>()
    for (const [path, e] of this.entries) {
      if (!path.startsWith(dir)) continue
      const rest = path.slice(dir.length)
      const slash = rest.indexOf('/')
      if (slash !== -1) {
        folders.add(rest.slice(0, slash))
        continue
      }
      const google = e.mimeType.startsWith('application/vnd.google-apps.')
      yield {
        id: encode(path),
        name: rest,
        mimeType: e.mimeType,
        modifiedTime: e.modified,
        // An md5 the way Drive computes one: over the bytes, so an identical put keeps it. Never for a Google document.
        md5Checksum: google ? undefined : Array.from(e.bytes).reduce((h, b) => (h * 31 + b) % 1_000_003, 7).toString(16),
        size: google ? undefined : e.bytes.byteLength,
        version: String(e.version),
      }
    }
    for (const name of folders) {
      yield { id: encode(`${dir}${name}/`), name, mimeType: FOLDER, modifiedTime: undefined, md5Checksum: undefined, size: undefined, version: undefined }
    }
  }
  async download(fileId: string) {
    const path = decode(fileId)
    this.downloads.push(path)
    const e = this.entries.get(path)
    if (e === undefined) throw new Error(`no such file ${path}`)
    return e.bytes
  }
  async export(fileId: string, mimeType: string) {
    const path = decode(fileId)
    this.exports.push(`${path} as ${mimeType}`)
    const e = this.entries.get(path)
    if (e === undefined) throw new Error(`no such file ${path}`)
    return e.bytes
  }
}
const encode = (path: string) => `id:${path}`
const decode = (id: string) => id.replace(/^id:/, '')

class FakeIndex implements Index {
  readonly adds: Mapped[] = []
  readonly removes: string[] = []
  #n = 0
  async add(doc: Mapped) {
    this.adds.push(doc)
    return { documentId: `doc-${String(++this.#n)}`, unchanged: false }
  }
  async remove(id: string) {
    this.removes.push(id)
    return true
  }
}

const mapping = compileMapping({
  layer: '${layer}',
  externalId: '${path}',
  title: '${name}',
  content: '${content}',
  metadata: { file_id: '${file_id}', mime_type: '${mime_type}' },
})
const quiet = { skipped: () => undefined, failed: () => undefined }
const provenance = { connector: 'drive', source: 'memory' }

function source(drive: Drive, o: { include?: string[]; exclude?: string[]; maxBytes?: number } = {}) {
  return new DriveSource({
    drive,
    folder: 'root',
    include: o.include ?? ['**'],
    exclude: o.exclude ?? ['**/*.tmp'],
    rules: parseLayerRules('docs/**=handbook;src/**=code', 'DRIVE_LAYERS'),
    maxBytes: o.maxBytes ?? 1024,
  })
}
const freshState = () => new State(join(mkdtempSync(join(tmpdir(), 'drive-')), 'state.sqlite'))

describe('the three verbs over a Drive folder', () => {
  it('walks the folder, exports a Google Doc as Word, reads text as text and files as bytes, skips what it cannot read, and removes what left', async () => {
    const drive = new MemoryDrive()
    drive.put('docs/leave.md', '# Leave\n\nalphaleave', 'text/markdown')
    drive.putDoc('docs/budget', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))
    drive.put('docs/scan.bin', new Uint8Array([0xff, 0xfe, 0x00, 0x01]))
    drive.put('docs/memo', new Uint8Array([0x7b, 0x5c, 0x72, 0x74, 0x66, 0x31]), 'text/rtf')
    drive.putDoc('docs/survey', new Uint8Array([1]), GOOGLE_FORM)
    drive.put('src/a.ts', 'export const a = 1', 'text/plain')
    drive.put('src/deep/b.ts', 'export const b = 2', 'text/plain')
    drive.put('src/big.ts', 'x'.repeat(4096), 'text/plain')
    drive.put('notes.txt', 'unmapped', 'text/plain')
    drive.put('docs/draft.tmp', 'excluded', 'text/plain')
    const index = new FakeIndex()
    const state = freshState()
    const skipped: string[] = []
    const report = { skipped: (reason: string, item: string, detail: string) => void skipped.push(`${reason}:${item}:${detail}`), failed: () => undefined }

    const first = await sweep({ source: source(drive), mapping, index, state, provenance, report })
    expect(first).toMatchObject({ complete: true, added: 5, skipped: { unmapped: 2, oversize: 1, binary: 1 } })
    expect(skipped.sort()).toEqual([
      `binary:id:docs/scan.bin:not UTF-8 text and not a format the index reads (application/octet-stream)`,
      `oversize:id:src/big.ts:4096 bytes, DRIVE_MAX_BYTES is 1024`,
      `unmapped:id:docs/survey:${GOOGLE_FORM} exports to nothing the index reads`,
      `unmapped:id:notes.txt:no layer rule matches`,
    ])
    // The oversize file was never downloaded: the listing said its size. The form was never exported: its type said so.
    expect(drive.downloads).not.toContain('src/big.ts')
    expect(drive.exports).toEqual([`docs/budget as ${DOCX}`])

    const byId = Object.fromEntries(index.adds.map((d) => [d.externalId, d]))
    expect(byId['docs/leave.md']).toMatchObject({
      layer: 'handbook',
      content: '# Leave\n\nalphaleave',
      metadata: { file_id: 'id:docs/leave.md', mime_type: 'text/markdown' },
    })
    expect(byId['src/a.ts']?.layer).toBe('code')
    expect(byId['src/deep/b.ts']?.layer).toBe('code')
    // The Google Doc: exported bytes, the Word type, and the name carrying the extension the index sees.
    expect(byId['docs/budget.docx']).toMatchObject({ layer: 'handbook', title: 'budget.docx', contentType: DOCX, content: undefined, metadata: { mime_type: GOOGLE_DOC } })
    expect(byId['docs/budget.docx']?.bytes).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))
    // By the file's own type, where the name has no telling extension — and
    // canonical, so the alias Drive reports is sent as the row it names.
    expect(byId['docs/memo']?.contentType).toBe('application/rtf')

    // Unchanged checksums, and an unchanged time-and-version for the Doc: nothing fetched on the second sweep.
    drive.downloads.length = 0
    drive.exports.length = 0
    const second = await sweep({ source: source(drive), mapping, index, state, provenance, report: quiet })
    expect(second).toMatchObject({ added: 0, changed: 0, unchanged: 5 })
    expect(drive.downloads).toEqual([])
    expect(drive.exports).toEqual([])

    // A change, an edit to the Doc, and a removal.
    drive.put('docs/leave.md', '# Leave\n\ngammaleave', 'text/markdown')
    drive.putDoc('docs/budget', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9]))
    drive.entries.delete('src/a.ts')
    const third = await sweep({ source: source(drive), mapping, index, state, provenance, report: quiet })
    expect(third).toMatchObject({ changed: 2, removed: 1, unchanged: 2 })
    expect(drive.downloads).toEqual(['docs/leave.md'])
    expect(drive.exports).toEqual([`docs/budget as ${DOCX}`])
    expect(index.removes).toHaveLength(1)
  })

  it('removes nothing when a folder\'s listing fails, even one folder deep', async () => {
    const drive = new MemoryDrive()
    drive.put('docs/leave.md', 'alpha', 'text/markdown')
    drive.put('src/a.ts', 'a', 'text/plain')
    const index = new FakeIndex()
    const state = freshState()
    await sweep({ source: source(drive), mapping, index, state, provenance, report: quiet })
    expect(state.count()).toBe(2)

    drive.entries.delete('docs/leave.md')
    drive.failing = 'src/'
    const broken = await sweep({ source: source(drive), mapping, index, state, provenance, report: quiet })
    expect(broken.complete).toBe(false)
    expect(broken.error).toContain('503')
    expect(broken.removed).toBe(0)
    expect(index.removes).toEqual([])
    expect(state.count()).toBe(2)

    // The next complete listing does remove it.
    drive.failing = undefined
    const next = await sweep({ source: source(drive), mapping, index, state, provenance, report: quiet })
    expect(next).toMatchObject({ complete: true, removed: 1 })
  })

  it('lists only what include admits and exclude does not', async () => {
    const drive = new MemoryDrive()
    drive.put('docs/leave.md', 'a', 'text/markdown')
    drive.put('docs/old/leave.md', 'b', 'text/markdown')
    drive.put('src/a.ts', 'c', 'text/plain')
    const paths = async (s: DriveSource) => {
      const out: string[] = []
      for await (const item of s.list()) out.push(String(item.fields['path']))
      return out.sort()
    }
    expect(await paths(source(drive, { include: ['docs/**'] }))).toEqual(['docs/leave.md', 'docs/old/leave.md'])
    expect(await paths(source(drive, { include: ['docs/**'], exclude: ['docs/old/**'] }))).toEqual(['docs/leave.md'])
  })

  it('caps an export after making it, since the listing carries no size for a Google document', async () => {
    const drive = new MemoryDrive()
    drive.putDoc('docs/long', new Uint8Array(4096))
    const index = new FakeIndex()
    const r = await sweep({ source: source(drive), mapping, index, state: freshState(), provenance, report: quiet })
    expect(r).toMatchObject({ added: 0, skipped: { oversize: 1 } })
    expect(drive.exports).toHaveLength(1)
  })

  it('declares a Word, Excel or PowerPoint export under the kit\'s own row for it', () => {
    expect(Object.values(EXPORTS).map((e) => e.extension)).toEqual(['docx', 'xlsx', 'pptx'])
    for (const e of Object.values(EXPORTS)) expect(e.contentType).toMatch(/^application\/vnd\.openxmlformats-officedocument\./)
  })
})

describe('the credential', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drive-key-'))
  const refusal = (name: string, body: string) => {
    const path = join(dir, name)
    writeFileSync(path, body)
    return () => loadServiceAccountKey(path, 'DRIVE_CREDENTIALS')
  }

  it('refuses, by name, a file that is missing, not JSON, or not a service account key', () => {
    expect(() => loadServiceAccountKey(join(dir, 'absent.json'), 'DRIVE_CREDENTIALS')).toThrow(/^DRIVE_CREDENTIALS names .*absent\.json.*cannot be read/)
    expect(refusal('text.json', 'not json')).toThrow(/^DRIVE_CREDENTIALS names .*not JSON/)
    expect(refusal('user.json', JSON.stringify({ type: 'authorized_user', client_id: 'x' }))).toThrow(/^DRIVE_CREDENTIALS names .*not a service account key/)
    expect(refusal('no-email.json', JSON.stringify({ type: 'service_account', private_key: '-----BEGIN' }))).toThrow(/^DRIVE_CREDENTIALS: .*client_email/)
    expect(refusal('no-key.json', JSON.stringify({ type: 'service_account', client_email: 'a@b' }))).toThrow(/^DRIVE_CREDENTIALS: .*private_key/)
    expect(refusal('bad-pem.json', JSON.stringify({ type: 'service_account', client_email: 'a@b', private_key: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n' }))).toThrow(
      /^DRIVE_CREDENTIALS: .*cannot be loaded/,
    )
  })
})
