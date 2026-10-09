# git

Keeps the text files of a git repository in Nacre layers. A file is a
document, its path is the `external_id`, a path rule picks its layer, and a
file that left the tree is a document that leaves the index. A blob's hash is
its version, so a sweep over a large repository reads only what moved.

```bash
docker run -v git-state:/state \
  -e NACRE_URL=https://nacre.example.com -e NACRE_TOKEN=... \
  -e GIT_URL=https://github.com/acme/handbook -e GIT_TOKEN=... \
  -e 'GIT_LAYERS=docs/**=handbook;src/**=code' \
  ghcr.io/nacre-work/connectors/git:0.1.1
```

The shared variables are in the [root README](../../README.md). This connector
also reads:

| variable | meaning | default |
|---|---|---|
| `GIT_URL` | What to clone: `https://`, `ssh://` or a path | required |
| `GIT_REF` | A branch or tag. Unset means the remote's `HEAD` | unset |
| `GIT_TOKEN` | A token for an `https://` remote, handed to git through a credential helper — never on a command line, never in the mirror's config | unset |
| `GIT_USERNAME` | The username that token is presented with | `x-access-token` |
| `GIT_DIR` | Where the bare mirror lives; keep it in the volume | beside `CONNECTOR_STATE`, as `repo.git` |
| `GIT_INCLUDE` | Comma-separated globs a path must match | `**` |
| `GIT_EXCLUDE` | Comma-separated globs a path must not match | empty |
| `GIT_LAYERS` | `glob=layer;glob=layer`, first match wins. The layer is a template over the path fields, so `src/**=code-${ext}` is a layer per language. A file no rule matches is skipped and counted as `unmapped` | required |
| `GIT_TITLE` | A template for the title | `${name}` |
| `GIT_MAX_BYTES` | Files above this are skipped as `oversize` | `1048576` |

Globs: `*` and `?` never cross a `/`; `**` matches any number of segments.
Templates are literal text with `${field}` and `${field|default}`, nothing
else. The fields a path offers:

| field | for `docs/people/leave.md` |
|---|---|
| `path` | `docs/people/leave.md` |
| `name` | `leave.md` |
| `dir` | `docs/people` |
| `ext` | `md` |
| `top` | `docs` |

Binary files — a NUL byte in the first 8000 — are skipped as `binary`;
symlinks and submodules are not listed at all. Every document carries
`metadata.path`, `metadata.ext` and `metadata.ref` beside the shared
`connector` and `source`.

**Why this may delete where `nacre ingest --watch` may not.** The core's
watcher never deletes, because a file vanishing from a directory is
indistinguishable from the first half of an editor's save. A commit has no
such race: a path absent from the tree was removed by somebody who meant it.
