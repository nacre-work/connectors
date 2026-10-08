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

/** `https://user:token@host/path` → `https://host/path`. Not a URL → unchanged. */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return value
  }
}
