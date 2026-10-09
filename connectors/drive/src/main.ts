/**
 * The drive connector. Every variable it reads is in README.md, which
 * `lint:config` holds in both directions.
 */
import { createRequire } from 'node:module'
import { boolean, integer, optional, parseGlobs, parseLayerRules, required, runConnector } from '@nacre.work/connector-kit'
import { googleDrive, loadServiceAccountKey } from './google.js'
import { DriveSource } from './source.js'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

// Read before anything else, so a key file that is missing or is not a
// service account key refuses the start by name rather than failing the
// first sweep with somebody else's `400`.
const key = loadServiceAccountKey(required('DRIVE_CREDENTIALS'), 'DRIVE_CREDENTIALS')
const subject = process.env['DRIVE_SUBJECT']?.trim() || undefined
const folder = required('DRIVE_FOLDER')
const sharedDrive = boolean('DRIVE_SHARED_DRIVE', false)
const api = optional('DRIVE_API', 'https://www.googleapis.com').replace(/\/+$/, '')
const tokenUrl = optional('DRIVE_TOKEN_URL', 'https://oauth2.googleapis.com/token')
const maxBytes = integer('DRIVE_MAX_BYTES', 10_485_760, { min: 1024 })

await runConnector({
  name: 'drive',
  version,
  source: `${api}/drive/v3/files/${folder}`,
  maxBytes,
  mapping: {
    layer: '${layer}',
    externalId: '${path}',
    title: optional('DRIVE_TITLE', '${name}'),
    content: '${content}',
    metadata: { path: '${path}', ext: '${ext|}', file_id: '${file_id}', mime_type: '${mime_type}' },
  },
  async open() {
    return new DriveSource({
      drive: googleDrive({ key, subject, api, tokenUrl, sharedDrive: sharedDrive ? folder : undefined }),
      folder,
      include: parseGlobs(optional('DRIVE_INCLUDE', '**')),
      exclude: parseGlobs(optional('DRIVE_EXCLUDE', '')),
      rules: parseLayerRules(required('DRIVE_LAYERS'), 'DRIVE_LAYERS'),
      maxBytes,
    })
  },
})
