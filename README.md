# Nacre connectors

Reference connectors that keep a source in sync with a [Nacre](https://github.com/nacre-work/nacre)
index: **a document the source has is in the index, a document the source changed
is changed, a document the source dropped is removed.** Each is one container,
built from this repository, configured entirely through its environment.

They are a simplification, not the way in. Nacre takes documents pushed over
its API, MCP, SDK or CLI, and the customer owns the sync; a connector is that
sync written once for a source many customers have. Apache 2.0, like the core.

| connector | source | image |
|---|---|---|
| [`git`](connectors/git/README.md) | the text files of a git repository, a path rule per layer | `ghcr.io/nacre-work/connectors/git` |
| [`s3`](connectors/s3/README.md) | the objects of a bucket — AWS, MinIO or any S3-compatible store — a key rule per layer, files as files | `ghcr.io/nacre-work/connectors/s3` |
| [`sql`](connectors/sql/README.md) | the rows a query returns — Postgres, MySQL or MariaDB — a template over the columns per layer, a watermark or the row's hash as its version | `ghcr.io/nacre-work/connectors/sql` |
| [`drive`](connectors/drive/README.md) | a Google Drive folder, recursively, or a shared drive — a path rule per layer, native files as files, a Google Doc as the Word file it exports to | `ghcr.io/nacre-work/connectors/drive` |

Planned, in this order: `mongo`, `imap`.

## Every connector

Reads these, whatever its source. Refuses to start on a missing or malformed
one, naming it — a connector that syncs nothing and reports success is the
failure every rule here is against.

| variable | meaning | default |
|---|---|---|
| `NACRE_URL` | The API's base URL, e.g. `https://nacre.example.com` | required |
| `NACRE_TOKEN` | A service account key holding `write` on every layer the connector maps to. `write` does not imply `read`, and the connector needs no `read`: it never searches | required |
| `CONNECTOR_STATE` | The SQLite file remembering what was sent, in a volume | `/state/connector.sqlite` |
| `SYNC_INTERVAL` | Seconds between sweeps, at least 10 | `300` |
| `SYNC_ONCE` | `true` runs one sweep and exits; the exit code is the sweep's verdict | `false` |
| `PORT` | Where `/healthz`, `/status` and `/metrics` answer | `9400` |

A sweep is a **complete listing** of the source. What it lists is added or
changed as its content hash decides; what a complete listing did *not* contain
is removed. A listing that breaks off removes nothing — the half it never
reached has not been called gone. That is the one property the state exists to
hold, and it is the first thing the suite checks.

Every document carries `metadata.connector` and `metadata.source`, so a search
can be narrowed to what one connector brought, and a layer's directory can say
where a document came from.

## Observing one

`GET /status` is a versioned contract — `contract: 1` — with the last sweep's
counts, running totals, the layers touched and the source with its credential
stripped. `GET /metrics` is the same in Prometheus's shape, every name prefixed
`nacre_connector_`. Both are unauthenticated on purpose: nothing in them is a
secret and the port is the operator's network. There is no dashboard here; a
Grafana over `/metrics` is the intended one, and a fleet view is a separate
product's.

## Developing

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test
pnpm lint:config      # every variable read is documented, every one documented is read
pnpm lint:images      # every connector has an image, a README, and is in the release
pnpm lint:workflows   # the aggregate and the workflows run the same gates
bash scripts/ci/live.sh git   # the three verbs against a real Nacre, in Docker
```

The unit suite proves the engine's arithmetic against a fake index. The live
run proves what the real index does with it — a connector is not written until
`live.sh` has watched its add, its change and its removal arrive in a search.
