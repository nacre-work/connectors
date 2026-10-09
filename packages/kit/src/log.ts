/**
 * One JSON line per event, on stderr, so stdout stays free for a connector
 * that is run as a command. Never a document's text, never a credential: the
 * callers pass counts, names and paths, and `redactUrl` strips userinfo from
 * anything that might carry a token.
 */
export type Fields = Record<string, string | number | boolean | null | undefined>

export function log(msg: string, fields: Fields = {}): void {
  const line: Record<string, unknown> = { ts: new Date().toISOString(), msg }
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) line[k] = v
  process.stderr.write(`${JSON.stringify(line)}\n`)
}

/**
 * `https://user:token@host/path` → `https://host/path`.
 *
 * Two parsers, because the first one falls through on exactly the strings
 * that carry a credential most often. WHATWG `URL` refuses a host *list* —
 * `mongodb://sync:pw@a:27017,b:27017/db`, a replica set's connection string,
 * and a Postgres one spelled with failover hosts — and the first version of
 * this returned such a value **unchanged**, password included, into `/status`
 * and the start-up log line. Found while building the mongo connector, which
 * is the first source whose URL the standard parser cannot read. So anything
 * shaped `scheme://userinfo@rest` has its userinfo cut before the `@` whether
 * or not it parses; a value with no `://` is not a URL and is returned as it
 * came.
 */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)@(.*)$/is.exec(value)
    return m === null ? value : `${m[1] ?? ''}${m[3] ?? ''}`
  }
}
