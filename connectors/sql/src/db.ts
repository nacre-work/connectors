/**
 * The database, through its driver. This is the one place a driver is named,
 * and there are two of them behind one port because the source asks one
 * question — every row of one statement, in order, without holding them all —
 * and the two families answer it with different clients: `pg` for Postgres,
 * `mysql2` for MySQL and MariaDB. The URL's scheme chooses, and nothing else
 * does: the statement is the operator's, written for their database, and a
 * driver is never asked to translate one.
 *
 * Both stream. A listing is every row the statement returns, and a table of a
 * million rows must not be a million rows in memory before the first one is
 * mapped: Postgres is read through a `pg-cursor`, a batch at a time over one
 * connection, and MySQL through the driver's own row stream, which pauses the
 * socket when the reader falls behind. The MySQL stream lives on the callback
 * API's `Query` and not on the promise wrapper, whose `query` buffers the
 * whole result and whose type does not expose the connection underneath — so
 * that side uses the callback connection and promises the two calls it makes.
 *
 * A connection per sweep, opened when the listing starts and closed when it
 * ends, however it ends. Sweeps are minutes apart, and a pool held across
 * them is a connection kept open to answer nothing.
 */
import { ConfigError } from '@nacre.work/connector-kit'
import { createConnection } from 'mysql2'
import { Client } from 'pg'
import Cursor from 'pg-cursor'

export type Row = Readonly<Record<string, unknown>>

/** What the source needs of a database, and all it needs. */
export interface Query {
  /** Every row the statement returns, streamed. Ending normally is what licenses removal; throwing does not. */
  rows(): AsyncIterable<Row>
}

export type Driver = 'postgres' | 'mysql'

/** The schemes `SQL_URL` takes, and which driver each names. */
export const SCHEMES: Readonly<Record<string, Driver>> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mariadb: 'mysql',
}

/** Rows read per round trip on the Postgres side; the MySQL stream's high-water mark. */
const BATCH = 500

/**
 * Which driver a URL names, refused by the scheme's own name when it is not
 * one of the four. Decided before anything connects, so a wrong URL is a
 * refusal at startup and not a sweep that fails on every interval.
 */
export function driverFor(url: string): Driver {
  let scheme: string
  try {
    scheme = new URL(url).protocol.replace(/:$/, '')
  } catch {
    throw new ConfigError('SQL_URL is not a URL; it takes postgres://, postgresql://, mysql:// or mariadb://')
  }
  const driver = SCHEMES[scheme]
  if (driver === undefined) {
    throw new ConfigError(`SQL_URL has the scheme ${scheme}://, which no driver here speaks; it takes postgres://, postgresql://, mysql:// or mariadb://`)
  }
  return driver
}

export function openQuery(url: string, statement: string): Query {
  return driverFor(url) === 'postgres' ? postgresQuery(url, statement) : mysqlQuery(url, statement)
}

function postgresQuery(url: string, statement: string): Query {
  return {
    async *rows() {
      const client = new Client({ connectionString: url })
      await client.connect()
      try {
        const cursor = client.query(new Cursor<Row>(statement))
        try {
          for (;;) {
            const batch = await cursor.read(BATCH)
            if (batch.length === 0) return
            yield* batch
          }
        } finally {
          // A close that fails after a read failed must not replace the
          // read's error with its own; the listing's error is the one to log.
          await cursor.close().catch(() => undefined)
        }
      } finally {
        await client.end().catch(() => undefined)
      }
    },
  }
}

function mysqlQuery(url: string, statement: string): Query {
  return {
    async *rows() {
      // The driver reads the parts of the URL and never its scheme, and its
      // own documentation spells the scheme `mysql://`; `mariadb://` is
      // accepted here as the name an operator of that server writes.
      const connection = createConnection({
        uri: url.replace(/^mariadb:/, 'mysql:'),
        // A BIGINT or DECIMAL arrives as text rather than as a number that
        // lost its low digits on the way — the same shape `pg` gives them.
        supportBigNumbers: true,
        bigNumberStrings: true,
      })
      await new Promise<void>((resolve, reject) => connection.connect((e) => (e ? reject(e) : resolve())))
      let ended = false
      try {
        for await (const row of connection.query(statement).stream({ highWaterMark: BATCH })) yield row as Row
        ended = true
      } finally {
        // A listing abandoned halfway has a query still open on the socket,
        // and `end` would wait for it; the socket is dropped instead.
        if (ended) await new Promise<void>((resolve) => connection.end(() => resolve()))
        else connection.destroy()
      }
    },
  }
}
