#!/usr/bin/env node
/**
 * The live run's hand on a bucket: make it, put an object, delete one.
 *
 * Through the same AWS client the s3 connector carries — resolved from the
 * connector's own `node_modules`, so this script adds nothing to the
 * workspace — because the alternative is `mc` inside the MinIO image, which
 * Chainguard's build does not ship, or a hand-signed request, which would be
 * a second S3 client in a repository whose one S3 client is the point.
 *
 *   s3.mjs mkbucket <bucket>
 *   s3.mjs put <bucket> <key> <file> [content-type]
 *   s3.mjs rm <bucket> <key>
 *
 * Reads S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../../connectors/s3/package.json', import.meta.url))
const { S3Client, CreateBucketCommand, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3')

const env = (name) => {
  const v = process.env[name]
  if (v === undefined || v === '') {
    console.error(`${name} is not set`)
    process.exit(2)
  }
  return v
}

const client = new S3Client({
  region: 'us-east-1',
  endpoint: env('S3_ENDPOINT'),
  forcePathStyle: true,
  credentials: { accessKeyId: env('S3_ACCESS_KEY_ID'), secretAccessKey: env('S3_SECRET_ACCESS_KEY') },
})

const [verb, bucket, key, file, contentType] = process.argv.slice(2)
switch (verb) {
  case 'mkbucket': {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }))
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }))
    }
    break
  }
  case 'put': {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: readFileSync(file),
        ...(contentType === undefined ? {} : { ContentType: contentType }),
      }),
    )
    break
  }
  case 'rm': {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    break
  }
  default:
    console.error('usage: s3.mjs mkbucket <bucket> | put <bucket> <key> <file> [content-type] | rm <bucket> <key>')
    process.exit(2)
}
