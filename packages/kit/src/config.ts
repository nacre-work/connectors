/**
 * Configuration is the environment, and every variable is refused at startup
 * rather than failing later — the core's `loadConfig` rule. A default that
 * quietly points at localhost is how a connector syncs nothing and reports
 * success.
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

export function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`${name} is not set. See the connector's README for every variable it reads.`)
  }
  return value.trim()
}

export function optional(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value.trim() === '' ? fallback : value.trim()
}

export function integer(name: string, fallback: number, bounds: { min: number; max?: number }): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < bounds.min || (bounds.max !== undefined && n > bounds.max)) {
    const range = bounds.max === undefined ? `>= ${String(bounds.min)}` : `between ${String(bounds.min)} and ${String(bounds.max)}`
    throw new ConfigError(`${name} is ${JSON.stringify(raw)}; it must be an integer ${range}.`)
  }
  return n
}

export function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const v = raw.trim().toLowerCase()
  if (v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'no') return false
  throw new ConfigError(`${name} is ${JSON.stringify(raw)}; it must be true or false.`)
}

/** The variables every connector reads, whatever its source. */
export interface KitConfig {
  readonly nacreUrl: string
  readonly nacreToken: string
  readonly statePath: string
  /** Seconds between sweeps. */
  readonly intervalSeconds: number
  /** One sweep and exit — what a cron job or a CI run wants. */
  readonly once: boolean
  readonly port: number
}

export function kitConfig(): KitConfig {
  return {
    nacreUrl: required('NACRE_URL'),
    nacreToken: required('NACRE_TOKEN'),
    statePath: optional('CONNECTOR_STATE', '/state/connector.sqlite'),
    intervalSeconds: integer('SYNC_INTERVAL', 300, { min: 10 }),
    once: boolean('SYNC_ONCE', false),
    port: integer('PORT', 9400, { min: 1, max: 65535 }),
  }
}
