/**
 * One JSON line per event, on stderr, so stdout stays free for a connector
 * that is run as a command. Never a document's text, never a credential: the
 * callers pass counts, names and paths, and `redactUrl` strips userinfo and
 * credential parameters from anything that might carry a token.
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
    return withoutCredentialParams(url.toString())
  } catch {
    const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)@(.*)$/is.exec(value)
    return withoutCredentialParams(m === null ? value : `${m[1] ?? ''}${m[3] ?? ''}`)
  }
}

/**
 * A credential carried as a query parameter, which userinfo is not the only
 * place for: libpq, the MySQL drivers and MongoDB all take `?password=`, and a
 * presigned or token-bearing URL carries its secret there too. The result of
 * `redactUrl` is not only logged — it is the `source` the engine writes into
 * every document's metadata, readable by everybody who can read the layer — so
 * a parameter left in place was a credential in the index.
 *
 * Matched by name, generously: losing a harmless parameter from a provenance
 * string costs nothing, and keeping a secret one is the thing this exists to
 * prevent. Filtered on the raw text rather than re-serialized through
 * `URLSearchParams`, so every parameter that stays is byte for byte what the
 * operator wrote.
 */
const CREDENTIAL_PARAM = /pass|pwd|secret|token|signature|credential|api[-_]?key/i
const BARE_CREDENTIAL_PARAM = new Set(['key', 'sig', 'auth'])

function withoutCredentialParams(value: string): string {
  const q = value.indexOf('?')
  if (q === -1 || !value.includes('://')) return value
  const hash = value.indexOf('#', q)
  const end = hash === -1 ? value.length : hash
  const kept = value
    .slice(q + 1, end)
    .split('&')
    .filter((pair) => {
      const raw = pair.split('=')[0] ?? ''
      let name = raw
      try {
        name = decodeURIComponent(raw)
      } catch {
        // A malformed escape is still a name; match it as written.
      }
      name = name.toLowerCase()
      return pair !== '' && !CREDENTIAL_PARAM.test(name) && !BARE_CREDENTIAL_PARAM.has(name)
    })
  return `${value.slice(0, q)}${kept.length > 0 ? `?${kept.join('&')}` : ''}${value.slice(end)}`
}
