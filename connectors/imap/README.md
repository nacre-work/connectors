# imap

Keeps the messages of a mailbox folder in Nacre layers — any server that
speaks IMAP. A message is a document, its `Message-ID` is the `external_id`,
a template over its headers picks its layer, an attachment the index reads is
a document of its own, and a message that left the folder is a document that
leaves the index. A message's `UIDVALIDITY:UID` is its version, so a sweep
over a large folder downloads only what arrived.

```bash
docker run -v imap-state:/state \
  -e NACRE_URL=https://nacre.example.com -e NACRE_TOKEN=... \
  -e 'IMAP_URL=imaps://archive%40example.com:...@imap.example.com/Archive' \
  -e IMAP_SINCE=2026-01-01 -e 'IMAP_LAYER=${header_x_layer|inbox}' \
  ghcr.io/nacre-work/connectors/imap:0.1.0
```

The shared variables are in the [root README](../../README.md). This connector
also reads:

| variable | meaning | default |
|---|---|---|
| `IMAP_URL` | `imaps://user:password@host[:port]/Folder`. The folder is the path, `INBOX` when there is none; the credential is percent-encoded, so an `@` in the user is `%40`. `imap://` connects in the clear, for a server on a network trusted with the credential — a container beside the stack, never across the internet. The credential is stripped from `/status` and from `metadata.source` | required |
| `IMAP_SINCE` | `YYYY-MM-DD`: only messages the server received on or after it are listed. An older message is not in the listing and is therefore treated as gone, so moving the date forward **removes** what fell behind it and moving it back adds what it reaches | unset |
| `IMAP_LAYER` | A template over the message's fields naming its layer, e.g. `${header_x_layer}` or `${to_user}`. A message a field it reads is missing from is skipped and counted as `missing_field` | required |
| `IMAP_TITLE` | A template for a message's title. An attachment's title is its filename | `${subject\|(no subject)}` |
| `IMAP_METADATA` | `key=template;key=template`, more metadata on every document, over the same fields. A key the connector writes itself is refused | empty |
| `IMAP_ATTACHMENTS` | `false` lists messages only | `true` |
| `IMAP_MAX_BYTES` | Messages above this are skipped as `oversize`, with their attachments, without being downloaded — the listing carries the size | `10485760` |

Templates are literal text with `${field}` and `${field|default}`, nothing
else. The fields a message offers:

| field | meaning |
|---|---|
| `subject` | decoded |
| `from` | the first `From` address |
| `to`, `to_user` | the first `To` address, and its local part — `alice` for `alice@example.com` |
| `date` | the `Date` header, ISO 8601 |
| `message_id` | the `Message-ID` without its angle brackets; absent when the message has none |
| `folder`, `uid` | where it is |
| `header_<name>` | every header, raw and unfolded: lower-case, `-` as `_`, so `X-Layer` is `header_x_layer` and `List-Id` is `header_list_id`. A repeated header keeps its first value |
| `filename`, `ext` | on an attachment only |

**Identity and version are two different things.** A message never changes
in place, but mail clients re-append a corrected copy under the same
`Message-ID` — a draft saved again, a note edited in an app that keeps notes
as mail — and the connector sees that as a change to one document rather than
a removal and an add of two. A message with no `Message-ID` is identified as
`uidvalidity:uid` instead, which is as stable as the folder is. A folder the
server rebuilt (a new `UIDVALIDITY`) re-versions every message: each is
downloaded once more, and the content hash decides that nothing changed.

**Attachments go up as files.** Each message is one document whose content
is its text (the HTML, as text, where there is only HTML). An attachment whose
name's extension or declared type is one the index reads — `pdf`, `docx`,
`pptx`, `xlsx`, `odt`, `odp`, `ods`, `epub`, `rtf` — is a second document,
`<message id>/<filename>`, sent as bytes under that type, in the message's
layer; the index extracts the text. What is attached is read from the
message's structure, so the listing knows every attachment's name and type
without downloading a body, and a message's bytes are downloaded once per
sweep however many attachments it carries. An attachment of any other type —
an image, a signature, a calendar invitation — is skipped as `binary`; two
attachments of one message under one name are one document, the first. A
binary document needs the Nacre deployment to have object storage
(`NACRE_S3_*`), which is the index's rule and not this connector's: without it
every file is refused and counted as `rejected`, with the server's reason in
the log.

Every document carries `metadata.folder`, `metadata.message_id`,
`metadata.from`, `metadata.date` and `metadata.filename` beside the shared
`connector` and `source` — the last is the attachment's name, and empty on a
message, so a search can be narrowed to either kind. The folder is
opened read-only: this connector never marks, moves or deletes a message.
