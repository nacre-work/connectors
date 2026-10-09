import { createPrivateKey, createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertion, DRIVE_SCOPE, googleDrive, loadServiceAccountKey, type ServiceAccountKey } from '../google.js'

// A throwaway pair, made here: never a key file in the tree, and a key the
// test did not make is a key the test cannot verify against.
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const key: ServiceAccountKey = { clientEmail: 'sync@example.iam.gserviceaccount.com', privateKey: pair.privateKey }
const TOKEN_URL = 'https://oauth2.example/token'

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>

describe('the signed assertion', () => {
  it('is a JWT whose header, claims and RS256 signature are what the token endpoint checks', () => {
    const at = new Date('2026-03-01T12:00:00Z')
    const jwt = assertion(key, { scope: DRIVE_SCOPE, audience: TOKEN_URL, issuedAt: at })
    const [header, claims, signature, ...rest] = jwt.split('.')
    expect(rest).toEqual([])
    expect(decode(header as string)).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(decode(claims as string)).toEqual({
      iss: 'sync@example.iam.gserviceaccount.com',
      scope: DRIVE_SCOPE,
      aud: TOKEN_URL,
      iat: 1772366400,
      exp: 1772366400 + 3600,
    })
    // Verified with the public half, which is what Google holds: a signature
    // that only the signer could check would prove nothing.
    const verified = createVerify('RSA-SHA256')
      .update(`${header as string}.${claims as string}`)
      .verify(pair.publicKey, Buffer.from(signature as string, 'base64url'))
    expect(verified).toBe(true)
    // And not with another key.
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expect(createVerify('RSA-SHA256').update(`${header as string}.${claims as string}`).verify(other.publicKey, Buffer.from(signature as string, 'base64url'))).toBe(false)
  })

  it('carries the impersonated user as sub, and only then', () => {
    const at = new Date()
    const plain = decode(assertion(key, { scope: DRIVE_SCOPE, audience: TOKEN_URL, issuedAt: at }).split('.')[1] as string)
    const delegated = decode(assertion(key, { scope: DRIVE_SCOPE, audience: TOKEN_URL, issuedAt: at, subject: 'someone@example.com' }).split('.')[1] as string)
    expect(plain).not.toHaveProperty('sub')
    expect(delegated['sub']).toBe('someone@example.com')
  })

  it('round-trips through the key file loader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drive-sa-'))
    const path = join(dir, 'sa.json')
    writeFileSync(
      path,
      JSON.stringify({
        type: 'service_account',
        client_email: key.clientEmail,
        private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        token_uri: TOKEN_URL,
      }),
    )
    const loaded = loadServiceAccountKey(path, 'DRIVE_CREDENTIALS')
    expect(loaded.clientEmail).toBe(key.clientEmail)
    expect(loaded.privateKey.equals(createPrivateKey(pair.privateKey.export({ type: 'pkcs8', format: 'pem' })))).toBe(true)
  })
})

/** A Drive API in a function: records every request, answers from a script. */
function fakeApi(pages: Record<string, unknown>[]) {
  const requests: { url: URL; method: string; authorization: string | undefined; body: string | undefined }[] = []
  let tokens = 0
  const call: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const headers = new Headers(init?.headers)
    requests.push({ url, method: init?.method ?? 'GET', authorization: headers.get('authorization') ?? undefined, body: init?.body === undefined ? undefined : String(init.body) })
    if (url.toString() === TOKEN_URL) {
      tokens += 1
      return Response.json({ access_token: `tok-${String(tokens)}`, token_type: 'Bearer', expires_in: 3600 })
    }
    if (url.pathname === '/drive/v3/files') {
      const page = url.searchParams.get('pageToken') ?? '0'
      return Response.json(pages[Number(page)] ?? { files: [] })
    }
    if (url.pathname.endsWith('/export')) return new Response(new Uint8Array([0x50, 0x4b]), { headers: { 'content-type': url.searchParams.get('mimeType') ?? '' } })
    if (url.searchParams.get('alt') === 'media') return new Response('hello', { headers: { 'content-type': 'text/plain' } })
    return new Response('nope', { status: 404 })
  }
  return { call, requests }
}

describe('the REST client', () => {
  it('exchanges one assertion for a token it reuses, lists a folder page by page with the fields the source needs, and fetches by id', async () => {
    const api = fakeApi([
      { nextPageToken: '1', files: [{ id: 'f1', name: 'leave.md', mimeType: 'text/markdown', md5Checksum: 'abc', size: '12', version: '3', modifiedTime: '2026-01-01T00:00:00Z' }] },
      { files: [{ id: 'd1', name: 'budget', mimeType: 'application/vnd.google-apps.document', version: '7', modifiedTime: '2026-01-02T00:00:00Z' }] },
    ])
    const drive = googleDrive({ key, subject: 'someone@example.com', api: 'https://api.example/', tokenUrl: TOKEN_URL, sharedDrive: undefined, fetch: api.call })

    const files = []
    for await (const f of drive.children('folder-1')) files.push(f)
    expect(files).toEqual([
      { id: 'f1', name: 'leave.md', mimeType: 'text/markdown', md5Checksum: 'abc', size: 12, version: '3', modifiedTime: '2026-01-01T00:00:00Z' },
      { id: 'd1', name: 'budget', mimeType: 'application/vnd.google-apps.document', md5Checksum: undefined, size: undefined, version: '7', modifiedTime: '2026-01-02T00:00:00Z' },
    ])
    expect(await drive.download('f1')).toEqual(new TextEncoder().encode('hello'))
    expect(await drive.export('d1', 'application/x-docx')).toEqual(new Uint8Array([0x50, 0x4b]))

    // One token exchange, carrying the assertion as the jwt-bearer grant, with the delegated user in it.
    const exchanges = api.requests.filter((r) => r.url.toString() === TOKEN_URL)
    expect(exchanges).toHaveLength(1)
    const form = new URLSearchParams(exchanges[0]?.body)
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(decode(form.get('assertion')?.split('.')[1] as string)).toMatchObject({ aud: TOKEN_URL, sub: 'someone@example.com', scope: DRIVE_SCOPE })

    // Every Drive call bears that token; the listing asks the query, the fields and the shared-drive switches, and follows the page token.
    const listings = api.requests.filter((r) => r.url.pathname === '/drive/v3/files')
    expect(listings.map((r) => r.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-1'])
    expect(listings[0]?.url.searchParams.get('q')).toBe("'folder-1' in parents and trashed=false")
    expect(listings[0]?.url.searchParams.get('fields')).toBe('nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size,version)')
    expect(listings[0]?.url.searchParams.get('supportsAllDrives')).toBe('true')
    expect(listings[0]?.url.searchParams.get('includeItemsFromAllDrives')).toBe('true')
    expect(listings[0]?.url.searchParams.has('pageToken')).toBe(false)
    expect(listings[0]?.url.searchParams.has('corpora')).toBe(false)
    expect(listings[1]?.url.searchParams.get('pageToken')).toBe('1')
    const download = api.requests.find((r) => r.url.pathname === '/drive/v3/files/f1')
    expect(download?.url.searchParams.get('alt')).toBe('media')
    const exported = api.requests.find((r) => r.url.pathname === '/drive/v3/files/d1/export')
    expect(exported?.url.searchParams.get('mimeType')).toBe('application/x-docx')
  })

  it('confines a shared drive\'s listing to that drive', async () => {
    const api = fakeApi([{ files: [] }])
    const drive = googleDrive({ key, subject: undefined, api: 'https://api.example', tokenUrl: TOKEN_URL, sharedDrive: 'drive-9', fetch: api.call })
    for await (const _ of drive.children('drive-9')) void _
    const listing = api.requests.find((r) => r.url.pathname === '/drive/v3/files')
    expect(listing?.url.searchParams.get('corpora')).toBe('drive')
    expect(listing?.url.searchParams.get('driveId')).toBe('drive-9')
  })

  it('throws on a page that fails, which is a listing that must not be called complete', async () => {
    const call: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.toString() === TOKEN_URL) return Response.json({ access_token: 'tok', expires_in: 3600 })
      return new Response('{"error":{"message":"Rate Limit Exceeded"}}', { status: 429 })
    }
    const drive = googleDrive({ key, subject: undefined, api: 'https://api.example', tokenUrl: TOKEN_URL, sharedDrive: undefined, fetch: call })
    await expect(async () => {
      for await (const _ of drive.children('x')) void _
    }).rejects.toThrow(/answered 429/)
  })

  it('renews the token once it is about to expire', async () => {
    const api = fakeApi([{ files: [] }])
    let clock = new Date('2026-03-01T12:00:00Z')
    const drive = googleDrive({ key, subject: undefined, api: 'https://api.example', tokenUrl: TOKEN_URL, sharedDrive: undefined, fetch: api.call, now: () => clock })
    for await (const _ of drive.children('x')) void _
    clock = new Date(clock.getTime() + 3600_000 - 30_000)
    for await (const _ of drive.children('x')) void _
    const listings = api.requests.filter((r) => r.url.pathname === '/drive/v3/files')
    expect(listings.map((r) => r.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2'])
  })
})
