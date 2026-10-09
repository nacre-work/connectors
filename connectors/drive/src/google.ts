/**
 * Google Drive over `fetch`, and the service account that opens it. This is
 * the one place Google's API is named, and there is no client library behind
 * it on purpose: the connector makes three calls — list a folder, download a
 * file, export a document — and its credential is a JSON file holding an RSA
 * key, which `node:crypto` signs. `googleapis` would bring four hundred
 * packages into an image whose job is reading other people's documents, to
 * do what forty lines do here; the s3 connector takes the AWS SDK because its
 * credential is a *chain* the SDK already walks, and a service account key is
 * not a chain, it is a file.
 *
 * The credential is a signed assertion — RS256 over `{ iss, scope, aud, iat,
 * exp }`, with `sub` where the connector impersonates a user through
 * domain-wide delegation — exchanged at the token endpoint for a bearer token
 * that is kept until it is about to expire. The key is read once at startup
 * and refused by the name of the variable that named it: a file that is not
 * a service account key is a container that would start and then fail every
 * sweep with a `400` from somebody else's server.
 *
 * Both addresses are overridable, and the only reason is the live run: there
 * is no Google in CI, so the connector's image is driven against a stub that
 * answers the same routes from a directory. That proves the connector against
 * the API's *shape* and nothing more.
 */
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ConfigError } from '@nacre.work/connector-kit'
import type { Drive, DriveFile } from './source.js'

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'

export interface ServiceAccountKey {
  readonly clientEmail: string
  readonly privateKey: KeyObject
}

/**
 * The JSON key file Google's console hands out. Refused, naming `variable`,
 * unless it is readable, is JSON, says it is a service account and carries a
 * PEM the runtime can load — each by its own sentence, because "the credential
 * is wrong" sends an operator to check four things.
 */
export function loadServiceAccountKey(path: string, variable: string): ServiceAccountKey {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new ConfigError(`${variable} names ${JSON.stringify(path)}, which cannot be read: ${e instanceof Error ? e.message : String(e)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ConfigError(`${variable} names ${JSON.stringify(path)}, which is not JSON; a service account key is the JSON file Google's console downloads`)
  }
  const key = parsed as Record<string, unknown>
  if (parsed === null || typeof parsed !== 'object' || key['type'] !== 'service_account') {
    throw new ConfigError(`${variable} names ${JSON.stringify(path)}, which is not a service account key: its "type" is not "service_account"`)
  }
  const clientEmail = key['client_email']
  const pem = key['private_key']
  if (typeof clientEmail !== 'string' || clientEmail === '') throw new ConfigError(`${variable}: the key file has no "client_email"`)
  if (typeof pem !== 'string' || !pem.includes('-----BEGIN')) throw new ConfigError(`${variable}: the key file has no PEM "private_key"`)
  try {
    const privateKey = createPrivateKey(pem)
    if (privateKey.asymmetricKeyType !== 'rsa') throw new Error(`the key is ${String(privateKey.asymmetricKeyType)}, and Google signs assertions with RSA`)
    return { clientEmail, privateKey }
  } catch (e) {
    throw new ConfigError(`${variable}: the key file's "private_key" cannot be loaded: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export interface AssertionClaims {
  readonly scope: string
  /** The token endpoint, which is also the audience Google checks. */
  readonly audience: string
  /** A user to act as, through domain-wide delegation. */
  readonly subject?: string | undefined
  readonly issuedAt: Date
  /** Seconds the assertion is good for; Google refuses more than an hour. */
  readonly lifetimeSeconds?: number
}

/** The JWT Google's token endpoint takes: `base64url(header).base64url(claims).base64url(RS256 signature)`. */
export function assertion(key: ServiceAccountKey, claims: AssertionClaims): string {
  const iat = Math.floor(claims.issuedAt.getTime() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      iss: key.clientEmail,
      scope: claims.scope,
      aud: claims.audience,
      iat,
      exp: iat + (claims.lifetimeSeconds ?? 3600),
      ...(claims.subject === undefined ? {} : { sub: claims.subject }),
    }),
  )
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key.privateKey)
  return `${header}.${payload}.${base64url(signature)}`
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

export interface GoogleDriveOptions {
  readonly key: ServiceAccountKey
  readonly subject: string | undefined
  /** `https://www.googleapis.com`, or the stub. */
  readonly api: string
  /** `https://oauth2.googleapis.com/token`, or the stub. */
  readonly tokenUrl: string
  /** The folder is a shared drive's root, which Drive lists only when asked by that drive's id. */
  readonly sharedDrive: string | undefined
  readonly fetch?: typeof fetch
  readonly now?: () => Date
}

const FIELDS = 'nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size,version)'

export function googleDrive(o: GoogleDriveOptions): Drive {
  const call = o.fetch ?? fetch
  const now = o.now ?? (() => new Date())
  const api = o.api.replace(/\/+$/, '')
  let token: { value: string; expiresAt: number } | undefined

  // One token at a time, renewed a minute before it expires rather than on
  // the `401` — a listing that fails halfway through for an expired token is
  // a sweep that removes nothing, which is correct and costs a whole sweep.
  const bearer = async (): Promise<string> => {
    const at = now()
    if (token !== undefined && token.expiresAt - at.getTime() > 60_000) return token.value
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: assertion(o.key, { scope: DRIVE_SCOPE, audience: o.tokenUrl, subject: o.subject, issuedAt: at }),
    })
    const res = await call(o.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
    if (!res.ok) throw new Error(`the token endpoint answered ${String(res.status)} to the service account's assertion: ${await reason(res)}`)
    const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown }
    if (typeof json.access_token !== 'string' || json.access_token === '') throw new Error('the token endpoint answered without an access_token')
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600
    token = { value: json.access_token, expiresAt: at.getTime() + expiresIn * 1000 }
    return token.value
  }

  const get = async (path: string, query: Record<string, string>): Promise<Response> => {
    const url = new URL(`${api}${path}`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    const res = await call(url, { headers: { authorization: `Bearer ${await bearer()}` } })
    if (!res.ok) throw new Error(`${path} answered ${String(res.status)}: ${await reason(res)}`)
    return res
  }

  return {
    async *children(folderId: string): AsyncIterable<DriveFile> {
      let pageToken: string | undefined
      do {
        const res = await get('/drive/v3/files', {
          q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed=false`,
          fields: FIELDS,
          pageSize: '1000',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          ...(o.sharedDrive === undefined ? {} : { corpora: 'drive', driveId: o.sharedDrive }),
          ...(pageToken === undefined ? {} : { pageToken }),
        })
        const page = (await res.json()) as { nextPageToken?: unknown; files?: unknown }
        if (!Array.isArray(page.files)) throw new Error(`the listing of ${folderId} carries no files array`)
        for (const f of page.files as Record<string, unknown>[]) {
          if (typeof f['id'] !== 'string' || typeof f['name'] !== 'string' || typeof f['mimeType'] !== 'string') continue
          yield {
            id: f['id'],
            name: f['name'],
            mimeType: f['mimeType'],
            modifiedTime: typeof f['modifiedTime'] === 'string' ? f['modifiedTime'] : undefined,
            md5Checksum: typeof f['md5Checksum'] === 'string' ? f['md5Checksum'] : undefined,
            // Drive reports the size as a string of digits, as it does every int64.
            size: f['size'] === undefined ? undefined : Number(f['size']),
            version: f['version'] === undefined ? undefined : String(f['version']),
          }
        }
        pageToken = typeof page.nextPageToken === 'string' && page.nextPageToken !== '' ? page.nextPageToken : undefined
      } while (pageToken !== undefined)
    },
    async download(fileId: string) {
      const res = await get(`/drive/v3/files/${encodeURIComponent(fileId)}`, { alt: 'media', supportsAllDrives: 'true' })
      return new Uint8Array(await res.arrayBuffer())
    },
    async export(fileId: string, mimeType: string) {
      const res = await get(`/drive/v3/files/${encodeURIComponent(fileId)}/export`, { mimeType })
      return new Uint8Array(await res.arrayBuffer())
    },
  }
}

/** The first line of a refusal, for the log — never a document's bytes, which a `200` carries and a refusal does not. */
async function reason(res: Response): Promise<string> {
  try {
    return (await res.text()).split('\n')[0]?.slice(0, 200) ?? ''
  } catch {
    return ''
  }
}
