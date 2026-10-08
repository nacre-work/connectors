/**
 * The git connector. Every variable it reads is in README.md, which
 * `lint:config` holds in both directions.
 */
import { createRequire } from 'node:module'
import { integer, optional, parseGlobs, parseLayerRules, required, runConnector } from '@nacre.work/connector-kit'
import { GitSource } from './source.js'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

const url = required('GIT_URL')
const token = process.env['GIT_TOKEN']
const maxBytes = integer('GIT_MAX_BYTES', 1_048_576, { min: 1024 })

await runConnector({
  name: 'git',
  version,
  source: url,
  maxBytes,
  mapping: {
    layer: '${layer}',
    externalId: '${path}',
    title: optional('GIT_TITLE', '${name}'),
    content: '${content}',
    metadata: { path: '${path}', ext: '${ext|}', ref: optional('GIT_REF', 'HEAD') },
  },
  async open(config) {
    const source = new GitSource({
      url,
      ref: process.env['GIT_REF']?.trim() || undefined,
      dir: optional('GIT_DIR', `${config.statePath.replace(/[^/]*$/, '')}repo.git`),
      include: parseGlobs(optional('GIT_INCLUDE', '**')),
      exclude: parseGlobs(optional('GIT_EXCLUDE', '')),
      rules: parseLayerRules(required('GIT_LAYERS'), 'GIT_LAYERS'),
      maxBytes,
      credential: token === undefined || token === '' ? undefined : { username: optional('GIT_USERNAME', 'x-access-token'), token },
    })
    await source.open()
    return source
  },
})
