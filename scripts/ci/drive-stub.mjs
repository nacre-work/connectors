#!/usr/bin/env node
/**
 * A stub Google Drive, for the live run only: a directory on disk served
 * through the four routes the drive connector calls, in the shapes Google
 * answers them.
 *
 * There is no Google in CI and no credential anywhere, so the connector's
 * image is driven against this instead. What that proves is that the
 * connector speaks the API's *shape* — the assertion exchange, the query and
 * the page token on `files.list`, `alt=media`, `files.export` — and takes a
 * listing to the index through the three verbs. What it cannot prove is
 * anything about Google: a field this stub spells the way the documentation
 * does and Google spells differently, a quota, a shared drive's corpora, an
 * export Google refuses. That is the honest limit, and the connector's
 * README does not claim past it.
 *
 *   POST /token                                 any assertion → a token
 *   GET  /drive/v3/files?q='<id>' in parents…   a folder's children, two per
 *                                               page so paging is exercised
 *   GET  /drive/v3/files/<id>?alt=media         a native file's bytes
 *   GET  /drive/v3/files/<id>/export?mimeType=  a Google Doc's export
 *
 * The directory is read on **every** request, so the live run's edits take
 * effect without a restart. Ids are derived from paths — `root` for the
 * directory itself, a hash of the relative path for everything else — so
 * they are stable across requests, which the connector's state depends on. A
 * file named `*.gdoc` is listed as a Google Doc, with no size and no
 * checksum, whose export serves the `.docx` beside it; that `.docx` is not
 * listed itself. Every Drive route wants a bearer token, because a connector
 * that forgot to send one would otherwise pass here and fail at Google.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, relative } from 'node:path'
import { URLSearchParams } from 'node:url'

const ROOT = process.env.DRIVE_ROOT ?? '/drive'
const PORT = Number(process.env.PORT ?? '9500')
/** One, so a folder of two lists in two pages: the live tree's folders hold two files at most. */
const PAGE = Number(process.env.STUB_PAGE_SIZE ?? '1')

const FOLDER = 'application/vnd.google-apps.folder'
const GOOGLE_DOC = 'application/vnd.google-apps.document'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const idOf = (rel) => (rel === '' ? 'root' : createHash('sha1').update(rel).digest('hex').slice(0, 24))

/** Every entry under ROOT, by id, read fresh. */
function tree() {
  const byId = new Map()
  const walk = (dir) => {
    const rel = relative(ROOT, dir)
    const entries = readdirSync(dir).sort()
    const children = []
    for (const name of entries) {
      const path = join(dir, name)
      const st = statSync(path)
      const childRel = rel === '' ? name : `${rel}/${name}`
      if (st.isDirectory()) {
        children.push(idOf(childRel))
        walk(path)
        continue
      }
      if (name.endsWith('.gdoc')) {
        const docx = path.replace(/\.gdoc$/, '.docx')
        byId.set(idOf(childRel), {
          id: idOf(childRel),
          name: name.replace(/\.gdoc$/, ''),
          mimeType: GOOGLE_DOC,
          modifiedTime: st.mtime.toISOString(),
          version: String(Math.floor(st.mtimeMs)),
          exportPath: docx,
        })
        children.push(idOf(childRel))
        continue
      }
      // The export body of a Google Doc beside it is not a file of its own.
      if (name.endsWith('.docx') && entries.includes(name.replace(/\.docx$/, '.gdoc'))) continue
      const bytes = readFileSync(path)
      byId.set(idOf(childRel), {
        id: idOf(childRel),
        name,
        mimeType: mimeOf(name),
        modifiedTime: st.mtime.toISOString(),
        md5Checksum: createHash('md5').update(bytes).digest('hex'),
        size: String(bytes.byteLength),
        version: String(Math.floor(st.mtimeMs)),
        path,
      })
      children.push(idOf(childRel))
    }
    byId.set(idOf(rel), { id: idOf(rel), name: rel === '' ? 'root' : rel.split('/').pop(), mimeType: FOLDER, children })
  }
  walk(ROOT)
  return byId
}

function mimeOf(name) {
  if (name.endsWith('.md')) return 'text/markdown'
  if (name.endsWith('.ts') || name.endsWith('.txt')) return 'text/plain'
  if (name.endsWith('.docx')) return DOCX
  if (name.endsWith('.pdf')) return 'application/pdf'
  return 'application/octet-stream'
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const listed = ({ id, name, mimeType, modifiedTime, md5Checksum, size, version }) => ({
  id,
  name,
  mimeType,
  ...(modifiedTime === undefined ? {} : { modifiedTime }),
  ...(md5Checksum === undefined ? {} : { md5Checksum }),
  ...(size === undefined ? {} : { size }),
  ...(version === undefined ? {} : { version }),
})

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${String(PORT)}`)

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }

  if (req.method === 'POST' && url.pathname === '/token') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const form = new URLSearchParams(body)
      // The grant and an assertion that is shaped like a JWT, and nothing
      // about its signature: there is no key here to check one against.
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(form.get('assertion') ?? '')) {
        json(res, 400, { error: 'invalid_grant', error_description: 'expected a jwt-bearer grant carrying a JWT assertion' })
        return
      }
      json(res, 200, { access_token: 'stub-token', token_type: 'Bearer', expires_in: 3600 })
    })
    return
  }

  if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) {
    json(res, 401, { error: { code: 401, message: 'Login Required.' } })
    return
  }

  if (req.method === 'GET' && url.pathname === '/drive/v3/files') {
    const q = url.searchParams.get('q') ?? ''
    const m = /^'([^']+)' in parents and trashed\s*=\s*false$/.exec(q)
    if (!m) {
      json(res, 400, { error: { code: 400, message: `Invalid query: this stub answers '<id>' in parents and trashed=false, not ${JSON.stringify(q)}` } })
      return
    }
    const folder = tree().get(m[1])
    if (folder === undefined || folder.mimeType !== FOLDER) {
      json(res, 404, { error: { code: 404, message: `File not found: ${m[1]}.` } })
      return
    }
    const all = tree()
    const start = Number(url.searchParams.get('pageToken') ?? '0')
    const files = folder.children.slice(start, start + PAGE).map((id) => listed(all.get(id)))
    const next = start + PAGE < folder.children.length ? { nextPageToken: String(start + PAGE) } : {}
    console.log(`list ${m[1]} from ${String(start)}: ${String(files.length)} of ${String(folder.children.length)}`)
    json(res, 200, { ...next, files })
    return
  }

  const exp = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(url.pathname)
  if (req.method === 'GET' && exp) {
    const file = tree().get(exp[1])
    if (file === undefined || file.exportPath === undefined) {
      json(res, 403, { error: { code: 403, message: 'Export only supports Docs Editors files.' } })
      return
    }
    if (url.searchParams.get('mimeType') !== DOCX) {
      json(res, 400, { error: { code: 400, message: `this stub exports a Google Doc as ${DOCX} only` } })
      return
    }
    console.log(`export ${file.name} as docx`)
    res.writeHead(200, { 'content-type': DOCX })
    res.end(readFileSync(file.exportPath))
    return
  }

  const get = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)
  if (req.method === 'GET' && get && url.searchParams.get('alt') === 'media') {
    const file = tree().get(get[1])
    if (file === undefined || file.path === undefined) {
      json(res, 404, { error: { code: 404, message: `File not found: ${get[1]}.` } })
      return
    }
    console.log(`download ${file.name}`)
    res.writeHead(200, { 'content-type': file.mimeType })
    res.end(readFileSync(file.path))
    return
  }

  json(res, 404, { error: { code: 404, message: `this stub has no ${req.method ?? ''} ${url.pathname}` } })
})

server.listen(PORT, () => {
  console.log(`stub drive listening on :${String(PORT)}, serving ${ROOT}, ${String(PAGE)} files per page`)
})
