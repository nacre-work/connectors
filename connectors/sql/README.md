# sql

Keeps the rows a SQL query returns in Nacre layers — Postgres, MySQL or
MariaDB, chosen by the URL. A row is a document, one column is its
`external_id`, a template over its columns picks the layer, and a row the
query stopped returning is a document that leaves the index. A watermark
column is the row's version where the table has one; otherwise the row's own
hash is, computed from the result the query already returned, so a sweep
never reads a row twice.

```bash
docker run -v sql-state:/state \
  -e NACRE_URL=https://nacre.example.com -e NACRE_TOKEN=... \
  -e SQL_URL=postgres://reader:...@db.internal:5432/wiki \
  -e 'SQL_QUERY=SELECT id, kind, title, body, updated_at FROM pages WHERE published' \
  -e 'SQL_LAYER=${kind}' -e 'SQL_CONTENT=${body}' -e SQL_VERSION=updated_at \
  ghcr.io/nacre-work/connectors/sql:0.1.2
```

The shared variables are in the [root README](../../README.md). This connector
also reads:

| variable | meaning | default |
|---|---|---|
| `SQL_URL` | The connection URL: `postgres://` or `postgresql://` for Postgres, `mysql://` or `mariadb://` for MySQL and MariaDB. Any other scheme is refused at startup by name. The credential in it never reaches the index or `/status` | required |
| `SQL_QUERY` | The statement run on every sweep, whole, and streamed — a cursor on Postgres, the driver's row stream on MySQL — so a million rows are never a million rows in memory. Whether it is read-only is the operator's business: it runs as whatever `SQL_URL` signs in as, so sign in as a reader | required |
| `SQL_ID` | The column that is a row's identity: its value is the item's id and the default `external_id`. A row where it is `NULL`, or a result without it, fails the sweep by name rather than losing the row | `id` |
| `SQL_VERSION` | A watermark column — an `updated_at`, a version number. Unset, the version is a sha256 over the whole row; see below | unset |
| `SQL_LAYER` | A template over the row's columns naming the layer: `handbook`, or `${kind}` for a layer per value | required |
| `SQL_TITLE` | A template for the title. The `title` field is the `title` column where the result has one, and the identity where it has none or the row's is `NULL` | `${title}` |
| `SQL_CONTENT` | A template for the document's text | `${content}` |
| `SQL_EXTERNAL_ID` | A template for the `external_id` | the `SQL_ID` column's value |
| `SQL_METADATA` | `key=template;key=template`, keys lower-case letters, digits and underscores, each template over the row's columns | empty |
| `SQL_MAX_BYTES` | A row whose rendered content is larger is skipped as `oversize` | `10485760` |

Templates are literal text with `${field}` and `${field|default}`, nothing
else, and **a row's fields are its columns by name** — so a column a template
reads must be spelled as a template can reference it: lower-case letters,
digits and underscores. Postgres folds an unquoted identifier to lower case;
anything else is aliased in the statement (`SELECT "DocID" AS doc_id`), and
`SQL_ID` and `SQL_VERSION` are refused at startup when they are not. A `NULL`
is an absent field: a template with a `|default` renders the default, and one
without skips the row as `missing_field`, naming the column. A date or a
timestamp renders as ISO 8601; a `BIGINT` or a `DECIMAL` as the text the
database holds, never as a number that lost its low digits; a `JSON` column as
an object, whose keys a template reaches by dot (`${meta.owner}`).

**Text rows only.** A row with a column holding bytes — `bytea`, a `BLOB` — is
skipped as `binary`, naming the column: a file in a row has no name and no
type the index could be told, and files live in object stores, which is what
the [`s3`](../s3/README.md) connector is for. Select the text columns rather
than `*` over a table that carries one.

**The version is the cheap path, and there are two.** With `SQL_VERSION` set,
an unchanged watermark skips the hash and the comparison — a sweep over a
large table costs the query and nothing per row that did not move — and the
cost is the contract such a column already makes with everything that reads
it: a row edited without its watermark moving is not re-sent. A `NULL`
watermark says nothing about its row, so that row is hashed. Without one, the
version is a sha256 over the whole row as the query returned it, in canonical
key order, computed in the listing: the row is already in memory, so a changed
cell anywhere in it is a changed version, and the fetch the engine would make
for a changed item has nothing left to read.

Every document carries `metadata.row_id` — the `SQL_ID` column's value —
beside the shared `connector` and `source`, under whatever `SQL_METADATA`
adds. `/status` reports the URL with its credential stripped.
