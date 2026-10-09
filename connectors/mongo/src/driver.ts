/**
 * The collection, through the official driver. This is the one place the
 * driver is named: `MongoClient` parses the connection string — refusing a
 * malformed one before anything connects — and a cursor over `find` is the
 * listing, closed by the iteration that reads it, whichever way it ends.
 *
 * The filter is read as Extended JSON before it is sent, so an operator can
 * write a date or an id the way the shell prints one — `{"$date": …}`,
 * `{"$oid": …}` — in a variable that is otherwise plain JSON. The projection
 * goes as written: it names fields and nothing else.
 *
 * The connection string is parsed here too, by its own grammar, and that is
 * not a second parser for the sake of one. The kit's `redactUrl` reads a URL
 * through WHATWG `URL`, which refuses `mongodb://a:27017,b:27017/db` — a
 * replica set's ordinary spelling — and hands the string back unchanged, so a
 * credential in it would reach `/status` whole. And the driver's own parse
 * cannot say whether the string *named* a database: it answers `test` for one
 * that did not, and `test` is a name somebody may have written. What
 * `/status` shows is built from the parts rather than scrubbed from the
 * whole, and the query is dropped with the userinfo, because a session token
 * can be in it.
 */
import { BSON, MongoClient } from 'mongodb'
import type { Collection, Document } from './source.js'

export interface DriverOptions {
  readonly url: string
  readonly database: string
  readonly collection: string
}

export function mongoCollection(o: DriverOptions): Collection {
  const client = new MongoClient(o.url, { appName: 'nacre-connector-mongo' })
  const collection = client.db(o.database).collection(o.collection)
  return {
    async *find(filter: Document, projection: Document | undefined): AsyncIterable<Document> {
      const cursor = collection.find(BSON.EJSON.deserialize(filter as BSON.Document), projection === undefined ? {} : { projection })
      for await (const doc of cursor) yield doc as Document
    },
  }
}

// scheme :// [userinfo @] hosts [/ database] [? options] — the connection
// string's own grammar. A `/`, `?` or `@` inside a password is percent-encoded
// by the specification, so the first `@` ends the userinfo.
const CONNECTION_STRING = /^(mongodb(?:\+srv)?):\/\/(?:[^@/?]*@)?([^@/?]+)(?:\/([^?]*))?(?:\?.*)?$/

export interface ParsedUrl {
  /** Scheme and hosts, and nothing that could be a credential: what `/status` and the provenance show. */
  readonly origin: string
  /** The database the string names, or `undefined` when it names none. */
  readonly database: string | undefined
}

export function parseUrl(url: string): ParsedUrl {
  const m = CONNECTION_STRING.exec(url.trim())
  if (m === null) throw new Error('it is not mongodb://[user:password@]host[:port][,host[:port]…][/database][?options] or the mongodb+srv:// form of it')
  const [, scheme, hosts, path] = m
  const database = path === undefined || path === '' ? undefined : decodeURIComponent(path)
  return { origin: `${String(scheme)}://${String(hosts)}`, database }
}
