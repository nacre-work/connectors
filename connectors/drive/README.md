# drive

Keeps a Google Drive folder — every file under it, recursively — or a whole
shared drive in Nacre layers. A file is a document, its path under the folder
is the `external_id`, a path rule picks its layer, and a file that was trashed
or deleted is a document that leaves the index. A file's `md5Checksum` is its
version, so a sweep over a large Drive downloads only what changed.

```bash
docker run -v drive-state:/state -v ./service-account.json:/run/sa.json:ro \
  -e NACRE_URL=https://nacre.example.com -e NACRE_TOKEN=... \
  -e DRIVE_CREDENTIALS=/run/sa.json -e DRIVE_FOLDER=1AbC...xYz \
  -e 'DRIVE_LAYERS=Policies/**=handbook;Engineering/**=engineering' \
  ghcr.io/nacre-work/connectors/drive:0.1.2
```

The service account needs to be able to read the folder: share the folder
(or add the account to the shared drive) with the account's `client_email`,
or set `DRIVE_SUBJECT` to a user whose Drive it is and give the account
domain-wide delegation for the `drive.readonly` scope. The key file is read
once at startup and refused by name if it is not a service account key.

The shared variables are in the [root README](../../README.md). This connector
also reads:

| variable | meaning | default |
|---|---|---|
| `DRIVE_CREDENTIALS` | Path to the service account's JSON key file, mounted as a secret. Refused if it cannot be read or is not a service account key | required |
| `DRIVE_SUBJECT` | A user to impersonate, through domain-wide delegation. Unset, the service account acts as itself and sees what was shared with it | unset |
| `DRIVE_FOLDER` | The id of the folder to walk — the last part of its URL in Drive — or a shared drive's id with `DRIVE_SHARED_DRIVE=true` | required |
| `DRIVE_SHARED_DRIVE` | `true` when `DRIVE_FOLDER` is a shared drive's id rather than a folder's | `false` |
| `DRIVE_INCLUDE` | Comma-separated globs a path must match | `**` |
| `DRIVE_EXCLUDE` | Comma-separated globs a path must not match | empty |
| `DRIVE_LAYERS` | `glob=layer;glob=layer`, first match wins, over the path under the folder. The layer is a template over the path fields. A file no rule matches is skipped and counted as `unmapped` | required |
| `DRIVE_TITLE` | A template for the title | `${name}` |
| `DRIVE_MAX_BYTES` | Files above this are skipped as `oversize` — without being downloaded where the listing carries the size, and after the export where it does not | `10485760` |
| `DRIVE_API` | Where Drive's REST API answers. Exists only so the live run can point the connector at a stub; a deployment leaves it alone | `https://www.googleapis.com` |
| `DRIVE_TOKEN_URL` | Where the service account's assertion is exchanged for a token. Exists for the same stub, and a deployment leaves it alone too | `https://oauth2.googleapis.com/token` |

Globs and the path fields are the git connector's: `*` and `?` never cross a
`/`, `**` matches any number of segments, and a path offers `path`, `name`,
`dir`, `ext` and `top`, plus `file_id`, `mime_type`, `size`, `modified_time`
and `md5` here. The path is the file's name under each folder's name, so a
folder *Policies* holding *Leave.pdf* is `Policies/Leave.pdf`; two files with
one name in one folder, which Drive allows, are one `external_id`, and the
last one listed is the document.

**A Google document goes up as the file it exports to.** A Google Doc has no
bytes to download, so it is exported as Word, a Sheet as Excel and a Slides
deck as PowerPoint — three formats the index reads — and sent as that file,
with `.docx`, `.xlsx` or `.pptx` added to its name, so the rules, the
`external_id` and the index all see the same name. A form, a drawing, a site
or a shortcut exports to nothing the index reads and is skipped as
`unmapped`, with the type in the log.

**Files go up as files.** A native file whose extension or reported type is
one the index reads as a document — `pdf`, `docx`, `pptx`, `xlsx`, `odt`,
`odp`, `ods`, `epub`, `rtf` — is sent as bytes under that type, and the index
extracts the text. Anything else is read as UTF-8 text, and a file that is
neither is skipped as `binary`. A binary document, which every exported Google
document is, needs the Nacre deployment to have object storage (`NACRE_S3_*`):
that is the index's rule and not this connector's, and without it every file
is refused and counted as `rejected`, with the server's reason in the log.

Every document carries `metadata.path`, `metadata.ext`, `metadata.file_id`
and `metadata.mime_type` beside the shared `connector` and `source`. The
credential never leaves the container: the key signs an assertion that is
exchanged for a short-lived token, and `/status` reports the folder's address
and nothing of the account.
