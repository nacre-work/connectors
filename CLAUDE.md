# connectors

Reference connectors that keep a source in sync with a Nacre index. Public,
Apache 2.0 — the same licence as the core, on the core's own test for the
boundary: a developer on a laptop needs the thing that puts their repository
into the index, so it belongs in the open.

**The customer owns the sync, and that stays the product's answer.** Nacre
takes documents pushed over REST, MCP, the SDK and the CLI, and nothing here
changes that; a connector is one such sync written once for a source many
customers have. Which is why there are reference connectors and not a crawler
product: the sales material says "no connectors, the customer owns the sync",
and after this repository it says "and there are reference connectors" — not
"we crawl your drive".

## The three verbs

Synchronisation is **add, change and remove**, and the third is the whole
difficulty. Ingest is idempotent on `(layer, external_id)` plus the content
hash, so the first two cost a connector nothing but sending what it sees with a
stable id. The index cannot know the source dropped something — so every
connector keeps state, and the state exists for exactly one comparison: what a
**complete** listing contained against what was remembered.

A listing that broke off removes nothing. The half it never reached has not
been called gone, and `State.unseen` refuses to answer for a sweep that did not
finish rather than answering "everything". That is the property the suite
checks first and the one a connector must never be clever around.

Per source, the signal is different and the engine does not care:

| | changed | removed |
|---|---|---|
| git | the blob hash moved | the path left the tree — definitive, which is why this *may* delete where the core's `nacre ingest --watch` must not: a commit has no editor-save race |
| s3 | ETag | the key is gone |
| sql | a watermark column, or the row hash | the row is not in the query's result |
| drive | `md5Checksum`; for a Google document, which has no bytes to checksum, `modifiedTime` with `version` | absent from a complete walk of the folder — trashed or deleted; the trash is still there to take it back |
| mongo | a version field the deployment names, or the document's hash | the document is not in the filter's result |
| imap | UIDVALIDITY + UID | the message left the folder |

## Decisions, and whose they were

Agreed with the product owner before the first line, in this order:

- **Configuration is the environment and nothing else.** Credentials and
  endpoints as variables; the mapping as variables too, with a language that is
  literal text, `${field}` and `${field|default}` — not a template engine and
  not JavaScript. Anything else is refused at startup by the name of the
  variable it came from. A YAML file would be a second surface with a second
  check; it arrives when a connector genuinely cannot say its mapping in a
  line, and not before.
- **Office documents are the core's to read, not a connector's to convert.**
  The core's parser pins `pdf-inspector`, which is Firecrawl's, and `anydoc` is
  Firecrawl's converter for Word, PowerPoint, Excel, OpenDocument, RTF, EPUB and
  CSV — and it does not parse PDF itself, it carries `pdf-inspector` inside. So
  the core adopts `anydoc`, which moves `pdf-inspector` twenty releases forward
  in the same change, widens the binary allow-list past PDF, and the SDK gains
  the multipart upload it does not have. That is a core release, and the
  connector order is chosen so the ones that need it come after it: **git →
  s3 → sql → drive → mongo → imap**. Conversion in a connector was the
  alternative and was declined: it leaves the original bytes out of the index
  and would make a `connect`-side decision about what the product accepts.
- **No dashboard.** Each container answers `/healthz`, `/status` and
  `/metrics`, every document carries `metadata.connector` and
  `metadata.source`, and a Grafana over the metrics is the intended dashboard.
  A fleet view, if one is ever built, is a separate product's — which is why
  `/status` is a **versioned contract** from day one (`contract: 1`): a key is
  added by raising the number and never renamed under it, so a reader this
  repository does not know about can read it without this repository changing.
- **One connector, one image**: `ghcr.io/nacre-work/connectors/<name>`, every
  connector at one version, one tag releases them all.

## What the kit is

`packages/kit` is everything a connector does not have to say twice: the sync
engine, SQLite state through `node:sqlite` (built into Node, no dependency),
the mapping language, environment reading that refuses rather than defaults,
the SDK behind a four-method `Index` port, and the status book. A connector is
a `Source` — `list()` and `fetch()` — plus a mapping and a README. The one
dependency on the Nacre side is `@nacre.work/sdk`: a connector on the SDK holds
no second answer about what the API is, which is the public stand's rule about
`purge` applied here. A source's own client is the source's business — the s3
connector carries `@aws-sdk/client-s3`, because a hand-signed SigV4 would have
to grow the credential chain the SDK already has (an instance role, IRSA, SSO),
and a connector that could only take a static key pair is one that is run with
a static key pair.

**A file goes up as a file.** Since core 0.27.0 the index reads Word,
PowerPoint, Excel, OpenDocument, EPUB and RTF beside PDF, and the part must
declare the type — the index refuses to sniff. So a `Mapped` carries either
`content` or `bytes` with a `contentType`, and `packages/kit/src/formats.ts`
is the table that decides the declaration from what a connector knows: a key's
extension, or the type the store reports, canonicalised (`text/rtf` is sent as
`application/rtf`, the row the index stores). It is a copy of the core's
`packages/core/formats.ts`, row for row, and a copy is only safe while
something compares the copies: `lint:formats` fetches the core's file at the
version the kit's SDK resolves to and holds every row, both directions. A row
the index would refuse is a document rejected on every sweep; a row the table
lacks is a file skipped as binary that the index would have read.

**A skip the bytes decided is remembered by version.** An object the connector
refused — not UTF-8, over the size cap — would otherwise be downloaded and
refused again on every sweep, since a skip writes no document row for the
cheap path to compare against. `State.skips` holds the item, the version and
the reason; an unchanged version is skipped without a fetch, and a changed one
is fetched again. A refusal the *index* made is deliberately not remembered: it
may have been the index's state rather than the document's, and nothing here
should decide that a document is permanently unwanted.

**The sql connector is two drivers behind one port, and a row is its own
version.** A query offers no ETag — neither family of database carries a cheap
version by itself — so the connector offers two and the operator picks. A
watermark column is the cheap path the engine was built for, and its cost is
the contract such a column already makes with everything that reads it: a row
edited without `updated_at` moving is not re-sent, which is what the suite
asserts as the proof that the hash was skipped. Without one, the version is a
sha256 over the whole row in canonical key order, computed in the listing
because the row is already in memory — the statement returned it — so a
changed cell anywhere is a changed version and `fetch` returns nothing: the
one source here whose expensive half is empty. Postgres and MySQL answer the
port's one question, every row streamed, through `pg-cursor` and the driver's
own row stream, and `source.ts` imports neither; the URL's scheme chooses, and
an unknown one is refused at startup by name. Rows are text only: a `bytea`
makes a row a `binary` skip naming the column, because a file in a row has no
name and no type the index could be told, and files live in object stores.
The first version of the watermark case failed on its own fixture — the test
mapping rendered the watermark into the metadata, so moving it was a change
the hash was right to see — and the case renders it no longer, which is the
property stated rather than the test bent to pass. The live section drives a
second Postgres beside the index's own, because a connector pointed at the
database behind the index reads what it writes.

`paths.ts` is the kit's because the second connector needed it: a path rule per
layer and the path's fields (`dir`, `ext`, `top`, `name`) were git's, and s3
keys are paths.

An item's **version** is the cheap path: where a source offers one — a blob
hash, an ETag — and the state remembers it, the fetch and the hash are skipped.
A git tree lists ten thousand blobs and reads the ones that moved. The engine
decides a document's layer from the listing's fields for that reason, so a
mapping that needs the fetched content to name a layer disables the cheap path
rather than breaking it.

**The mongo connector has nothing to fetch, and the version is what keeps that
cheap.** A cursor hands over the whole document, so the listing holds every
field and `fetch` returns nothing; what a sweep costs is decided by
`Item.version`. A field the deployment names (`MONGO_VERSION`) is it, and
without one the version is SHA-256 over the document's canonical JSON — every
value as a template sees it, keys sorted at every depth — computed in the
listing over bytes already delivered, so a document that did not move is
neither mapped nor hashed by the engine. The official driver sits behind a
`Collection` port in `driver.ts`, the s3 connector's `aws.ts` arrangement, and
`source.ts` tells BSON values apart by `_bsontype` rather than importing one:
an `ObjectId` is hex, a `Date` is ISO, an array of scalars is joined, and an
embedded document is reached by a dotted path — the kit's language reads
`${author.name}` already, so nothing is flattened. **Text only.** A `Binary`
field is absent to a template and a mapping that names one skips the document
by that name; files live in object stores and the s3 connector reads them.
Writing it found that the kit's `redactUrl` hands a replica set's connection
string — `mongodb://a:27017,b:27017/db` — back **unchanged**, because WHATWG
`URL` refuses the host list, so a credential in one would have reached
`/status` whole; the connector reads the string by its own grammar and builds
what `/status` shows from the parts. The kit is repaired too rather than only
routed around: a connector that forgets to is the next instance, so
`redactUrl` cuts the userinfo before the `@` of anything shaped
`scheme://…@…` whether or not the standard parser reads it, and
`log.test.ts` pins the replica-set spelling, a Postgres failover list and a
password carrying an `@` of its own.

## What a connector is not written until

The unit suite drives the engine against a fake index and proves its
arithmetic: which items become which calls, that a break in the listing
removes nothing, that a change the index refused is not then removed as
unseen. A fake agrees with whatever it was written to, so it proves nothing
about what the real index does with a request.

`scripts/ci/live.sh <connector>` is the other half and the gate: the core's
**published** images at the version the kit's SDK pins, a writer account
holding `write` and a reader holding `read` — because `write` does not imply
`read`, and a connector that needed `read` would be a connector that could not
run on the account it should — and the connector's own image run over a source
this script edits between runs. It watches a search: the document arrives, its
text changes, it is gone. Under the constant-vector stub embedder every
permitted document is in every answer, which is what makes *absence* provable.
A connector whose three verbs have not been watched arrive is not written.

That script is one shared half and a section per connector — the source, the
run, and the two edits — so every connector is asked the verbs the same way,
and a connector in a workflow matrix without a section is refused by name. The
s3 section runs the stack with object storage and sends a Word document
through: the bytes go up as a file, the core extracts the text, and the phrase
comes back out of a search, which is the case the suite's in-memory bucket
cannot ask. `LIVE_FROM_DIST=1` runs the built `dist` on the host instead of
the image, for a sandbox whose Docker daemon cannot reach a registry through
its own TLS proxy; the summary line says which it ran, because a run that
measured the source is not a run that measured the artifact, and CI never
sets it.

**The drive connector walks a folder and carries no client library, and the
run that proves it has no Google behind it.** `googleapis` would bring four
hundred packages into an image whose job is reading other people's documents
to make three calls — list a folder, download a file, export a document — on
a credential that is a JSON file holding an RSA key; `node:crypto` signs the
assertion and `fetch` exchanges it, in `google.ts`, behind a `Drive` port the
suite fakes. That is not the s3 decision reversed: the AWS SDK is carried for
a credential *chain*, and a service account key is not a chain. The table
above said `changes.list` for this connector before it was written, and a
full walk is what was built — a complete listing is what licenses removal
everywhere else here, and a change feed that drops a page would call nothing
gone while believing itself complete. A Google Doc has no bytes, so it goes up
as the Word file Drive exports it to, a Sheet as Excel, a Slides deck as
PowerPoint — three rows of the kit's table — with the extension put on its
name so the rules, the `external_id` and the index agree on it; a form or a
drawing exports to nothing the index reads and is skipped as `unmapped`. And
there is no Google in CI and no credential anywhere, so the live section
drives the connector's image against `scripts/ci/drive-stub.mjs`, a
standard-library server in the stack that serves a directory as a Drive
through the connector's four routes, paging at one so paging is exercised.
That proves the connector against the API's *shape* and the three verbs
against the index; it proves nothing about Google — a field spelled the way
the documentation says and not the way Google answers, a quota, a shared
drive's corpora — which is the honest limit of a run with no account, and the
README claims nothing past it.

## Checks

The doctrine every sibling repository carries: a property that has to hold in
N places with nothing that knows N is repaired by a check that asks all N, not
by the instance. `lint:config` discovers every variable read and holds it
against the README that documents it, in both directions and per scope — the
kit's against the root, each connector's against its own, and a shared
variable re-documented in a connector is refused as a second claim.
`lint:images` holds every `connectors/*` to a Dockerfile, a README, a manifest
named after it, one version across all of them, and a row in both workflow
matrices, read from the workflows rather than kept as a list. `lint:workflows`
holds the aggregate against `lint:*` and `ci.yml` against both, and refuses a
pull-request workflow that cannot be started by hand. Each produced its
refusal before it was believed.

## Conventions

English everywhere. Conventional Commits, squash merge, one pull request one
topic. pnpm, the version from `packageManager`. Node 24. No secrets in this
repository — a key that reaches a commit means rotating the key. Say in the
pull request what needs a human outside it.
