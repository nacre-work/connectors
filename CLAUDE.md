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
| drive | `changes.list` | removed or trashed |
| mongo | a change stream or a date field | the document is gone |
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
dependency anywhere is `@nacre.work/sdk`: a connector on the SDK holds no
second answer about what the API is, which is the public stand's rule about
`purge` applied here.

An item's **version** is the cheap path: where a source offers one — a blob
hash, an ETag — and the state remembers it, the fetch and the hash are skipped.
A git tree lists ten thousand blobs and reads the ones that moved. The engine
decides a document's layer from the listing's fields for that reason, so a
mapping that needs the fetched content to name a layer disables the cheap path
rather than breaking it.

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
