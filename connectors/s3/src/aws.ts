/**
 * The bucket, through the AWS SDK. This is the one place the SDK is named,
 * and the reason it is the SDK rather than a hand-signed client is where this
 * container runs: inside somebody's AWS account, where the credential is an
 * instance role, IRSA or SSO far more often than a static key pair. The SDK's
 * default chain finds those; a signer written here would need a key in the
 * environment and nothing else.
 *
 * MinIO and every other S3-compatible store take the same client with an
 * endpoint and path-style addressing, which is what the live run uses.
 */
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import type { ObjectStore, StoredObject } from './source.js'

export interface AwsStoreOptions {
  readonly bucket: string
  readonly region: string
  readonly endpoint: string | undefined
  readonly forcePathStyle: boolean
  /** Unset means the SDK's own chain: the environment, a profile, a role. */
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } | undefined
}

export function awsStore(o: AwsStoreOptions): ObjectStore {
  const client = new S3Client({
    region: o.region,
    forcePathStyle: o.forcePathStyle,
    ...(o.endpoint === undefined ? {} : { endpoint: o.endpoint }),
    ...(o.credentials === undefined ? {} : { credentials: o.credentials }),
  })
  return {
    async *list(prefix: string): AsyncIterable<StoredObject> {
      let token: string | undefined
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: o.bucket, Prefix: prefix === '' ? undefined : prefix, ContinuationToken: token }),
        )
        for (const c of page.Contents ?? []) {
          if (c.Key === undefined) continue
          yield { key: c.Key, etag: (c.ETag ?? '').replace(/"/g, ''), size: c.Size ?? 0, lastModified: c.LastModified }
        }
        // A truncated page with no token is a listing that cannot be finished,
        // and a listing that cannot be finished must not be called complete.
        if (page.IsTruncated === true && page.NextContinuationToken === undefined) {
          throw new Error(`the listing of ${o.bucket} is truncated and carries no continuation token`)
        }
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined
      } while (token !== undefined)
    },
    async get(key: string) {
      const object = await client.send(new GetObjectCommand({ Bucket: o.bucket, Key: key }))
      const bytes = (await object.Body?.transformToByteArray()) ?? new Uint8Array()
      return { bytes, contentType: object.ContentType }
    },
  }
}
