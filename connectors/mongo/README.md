# mongo

Keeps the documents of a MongoDB collection in Nacre layers. Every document a
filter matches is a document, a field of it is the `external_id`, a template
over its fields picks the layer, and a document gone from the result — deleted,
or edited out of the filter — is a document that leaves the index. A field the
deployment names is the version, so a sweep over a large collection maps only
what moved; without one, the document's own hash is.

```bash
docker run -v mongo-state:/state \
  -e NACRE_URL=https://nacre.example.com -e NACRE_TOKEN=... \
  -e MONGO_URL=mongodb://sync:...@mongo.internal:27017/corp -e MONGO_COLLECTION=articles \
  -e 'MONGO_FILTER={"status":"published"}' -e MONGO_VERSION=updated_at \
  -e 'MONGO_LAYER=${section}' -e 'MONGO_TITLE=${title}' -e 'MONGO_CONTENT=${body}' \
  ghcr.io/nacre-work/connectors/mongo:0.1.1
```

The shared variables are in the [root README](../../README.md). This connector
also reads:

| variable | meaning | default |
|---|---|---|
| `MONGO_URL` | The connection string, `mongodb://` or `mongodb+srv://`, with the credential in it. `/status` and `metadata.source` show the scheme and the hosts and nothing else — not the userinfo, not the query, which can carry a session token | required |
| `MONGO_DATABASE` | The database. Unset, the one the connection string names; refused when neither names one | from `MONGO_URL` |
| `MONGO_COLLECTION` | The collection | required |
| `MONGO_FILTER` | A JSON object: the query every sweep runs, so what it matches is the whole of what the index holds. Extended JSON is understood, so a date is `{"$date":"2026-01-01T00:00:00Z"}` and an id `{"$oid":"…"}`. Not an object is refused by name | `{}` |
| `MONGO_PROJECTION` | A JSON object naming the fields to read, to keep a listing over wide documents small. A field a template reads but the projection drops is a document skipped as `missing_field`; dropping `_id` is refused | unset, every field |
| `MONGO_ID` | The field that is the identity — the `external_id` by default, and `metadata.doc_id` always. Nested by dots. An `ObjectId` is its hex string; a document without the field, or with a document or an array there, is skipped as `missing_field` | `_id` |
| `MONGO_VERSION` | A field that moves when the document does — an `updated_at`, a revision number — nested by dots. A document whose field did not move is neither mapped nor hashed on the next sweep; one without the field is versioned by its hash, as below | unset |
| `MONGO_LAYER` | A template over the document's fields naming the layer, such as `${section}` or `wiki-${lang\|en}` | required |
| `MONGO_TITLE` | A template for the title. Unset sends none, and the index derives one | unset |
| `MONGO_CONTENT` | A template for the text. A document whose rendering is empty is skipped as `empty` | `${content}` |
| `MONGO_EXTERNAL_ID` | A template for the `external_id` | `${doc_id}` |
| `MONGO_METADATA` | `key=template;key=template`, keys as the index spells them — lower-case letters, digits and underscores | empty |
| `MONGO_MAX_BYTES` | Documents whose rendered content is above this are skipped as `oversize` | `10485760` |

Templates are literal text with `${field}` and `${field|default}`, nothing
else, and a template a field is missing from skips the document as
`missing_field` naming the field — never sends the string `undefined`. A field
is reached by its name, and a nested one by a dotted path: `${author.name}`
reads `{"author": {"name": "Dana"}}`. The name has to be one the language can
spell — lower-case letters, digits and underscores — so a field such as
`createdAt` is reachable by `MONGO_ID` and `MONGO_VERSION`, which read a path
directly, and not by a template. One field is the connector's: `doc_id`, the
identity as rendered, which shadows a document field of that name.

What a template sees of a value:

| in the document | rendered |
|---|---|
| a string, a number, a boolean | as is |
| `ObjectId` | its 24-character hex string |
| `Date` | ISO 8601, `2026-03-04T05:06:07.089Z` |
| `Long`, `Decimal128` | the decimal text, exactly |
| a UUID | hyphenated, `5a3a8502-2b53-…` |
| an array of scalars | the items joined with `, `; `null`s dropped |
| an array of documents | JSON |
| an embedded document | reached by a dotted path, or JSON whole |
| `null` | absent — `${field\|default}` renders the default |
| `Binary` bytes | **absent** |

**Text only.** A `Binary` field is not a document and is not offered to a
template: a mapping that names one skips the document as `missing_field`, and
a file stored in a collection stays where it is. Files live in object stores,
and the s3 connector reads them as files; GridFS is a bucket with a different
API and is deliberately not read here.

**The cheap path.** There is nothing to fetch: a cursor hands over the whole
document, so the listing already holds every field. What makes a sweep cheap
is the version. With `MONGO_VERSION` the state remembers the field, and a
document whose field did not move costs nothing past the cursor — not mapped,
not hashed, not sent. Without it the version is a SHA-256 over the document's
canonical JSON — every value as a template sees it, keys sorted at every
depth, bytes as base64 — computed in the listing over bytes the cursor already
delivered; a document whose hash did not move is skipped the same way, and one
whose hash moved is mapped again and sent only if what the index would be sent
changed. Both are decided from the listing, which is why `MONGO_LAYER` and
`MONGO_EXTERNAL_ID` read listing fields, and every field is one.

Every document carries `metadata.collection` and `metadata.doc_id` beside the
shared `connector` and `source`, under whatever `MONGO_METADATA` adds. A
change stream is deliberately not the mechanism: it starts from *now*, so the
first sweep would still be a full listing, and the removal of a document the
connector never saw leave would need the listing anyway — which is the
comparison the engine already makes.
