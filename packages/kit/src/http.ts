/**
 * Three paths and nothing else. No authentication on purpose: nothing here is
 * a secret — counts, layer names, a source with its credential stripped — and
 * the port is for the operator's own network, the way `/metrics` on the core
 * is. A connector is not a server; this is how it is observed.
 */
import { createServer, type Server } from 'node:http'
import type { StatusBook } from './status.js'

export function serve(port: number, book: StatusBook): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(404)
      res.end()
      return
    }
    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true }))
      return
    }
    if (url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(book.status()))
      return
    }
    if (url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : book.metrics())
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(port)
  return server
}
