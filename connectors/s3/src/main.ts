/**
 * The s3 connector. Every variable it reads is in README.md, which
 * `lint:config` holds in both directions.
 */
import { createRequire } from 'node:module'
import { boolean, ConfigError, integer, optional, parseGlobs, parseLayerRules, required, runConnector } from '@nacre.work/connector-kit'
import { awsStore } from './aws.js'
import { S3Source } from './source.js'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

const bucket = required('S3_BUCKET')
const prefix = optional('S3_PREFIX', '').replace(/^\/+/, '')
const endpoint = process.env['S3_ENDPOINT']?.trim() || undefined
const accessKeyId = process.env['S3_ACCESS_KEY_ID']?.trim() || undefined
const secretAccessKey = process.env['S3_SECRET_ACCESS_KEY']?.trim() || undefined
if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
  throw new ConfigError('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are a pair: set both, or neither and let the AWS credential chain decide')
}
const maxBytes = integer('S3_MAX_BYTES', 10_485_760, { min: 1024 })

await runConnector({
  name: 's3',
  version,
  source: `${endpoint ?? 's3:/'}/${bucket}/${prefix}`,
  maxBytes,
  mapping: {
    layer: '${layer}',
    externalId: '${path}',
    title: optional('S3_TITLE', '${name}'),
    content: '${content}',
    metadata: { path: '${path}', ext: '${ext|}', bucket, key: '${key}' },
  },
  async open() {
    return new S3Source({
      store: awsStore({
        bucket,
        region: optional('S3_REGION', 'us-east-1'),
        endpoint,
        forcePathStyle: boolean('S3_FORCE_PATH_STYLE', false),
        credentials: accessKeyId === undefined || secretAccessKey === undefined ? undefined : { accessKeyId, secretAccessKey },
      }),
      prefix,
      include: parseGlobs(optional('S3_INCLUDE', '**')),
      exclude: parseGlobs(optional('S3_EXCLUDE', '')),
      rules: parseLayerRules(required('S3_LAYERS'), 'S3_LAYERS'),
      maxBytes,
    })
  },
})
