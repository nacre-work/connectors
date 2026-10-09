# s3

Keeps the objects of a bucket in Nacre layers — AWS S3, MinIO, or any store
that speaks S3. An object is a document, its key under the prefix is the
`external_id`, a key rule picks its layer, and an object that left the bucket
is a document that leaves the index. An object's ETag is its version, so a
sweep over a large bucket downloads only what changed.

```bash
docker run -v s3-state:/state \
  -e NACRE_URL=https://nacre.example.com -e NACRE_TOKEN=... \
  -e S3_BUCKET=corp-documents -e S3_PREFIX=handbook/ -e S3_REGION=eu-central-1 \
  -e 'S3_LAYERS=policies/**=handbook;engineering/**=engineering' \
  ghcr.io/nacre-work/connectors/s3:0.1.0
```

The shared variables are in the [root README](../../README.md). This connector
also reads:

| variable | meaning | default |
|---|---|---|
| `S3_BUCKET` | The bucket | required |
| `S3_PREFIX` | Only keys under it are listed; it is stripped from the path the rules and fields see | empty |
| `S3_REGION` | The region the client signs for | `us-east-1` |
| `S3_ENDPOINT` | The store's URL, for MinIO or another S3-compatible store. Unset means AWS | unset |
| `S3_FORCE_PATH_STYLE` | `true` for a store that addresses buckets by path rather than by host — MinIO does | `false` |
| `S3_ACCESS_KEY_ID` | A static key, with the secret below. Set both or neither: unset, the AWS credential chain decides — `AWS_*` in the environment, a profile, an instance role, IRSA | unset |
| `S3_SECRET_ACCESS_KEY` | The secret for that key | unset |
| `S3_INCLUDE` | Comma-separated globs a path must match | `**` |
| `S3_EXCLUDE` | Comma-separated globs a path must not match | empty |
| `S3_LAYERS` | `glob=layer;glob=layer`, first match wins, over the path under the prefix. The layer is a template over the path fields. An object no rule matches is skipped and counted as `unmapped` | required |
| `S3_TITLE` | A template for the title | `${name}` |
| `S3_MAX_BYTES` | Objects above this are skipped as `oversize`, without being downloaded — the listing carries the size | `10485760` |

Globs and the path fields are the git connector's: `*` and `?` never cross a
`/`, `**` matches any number of segments, and a path offers `path`, `name`,
`dir`, `ext` and `top`, plus `key` (the full key), `size`, `etag` and
`last_modified` here.

**Files go up as files.** A key whose extension is one the index reads as a
document — `pdf`, `docx`, `pptx`, `xlsx`, `odt`, `odp`, `ods`, `epub`, `rtf` —
is sent as bytes under that type, and so is an object whose own `Content-Type`
is one of those; the index extracts the text. Anything else is read as UTF-8
text, and an object that is neither is skipped as `binary`. A binary document
needs the Nacre deployment to have object storage (`NACRE_S3_*`), which is the
index's rule and not this connector's: without it every file is refused and
counted as `rejected`, with the server's reason in the log.

Every document carries `metadata.path`, `metadata.ext`, `metadata.bucket` and
`metadata.key` beside the shared `connector` and `source`. The credential never
reaches the index: `metadata.bucket` is the bucket's name, and `/status`
reports the endpoint without it.
