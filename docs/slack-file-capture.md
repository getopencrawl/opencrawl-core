# Slack files: capture, document text and indexing

Airbyte message/file previews are not document bodies. The optional core Slack
file capture adapter enumerates public channels (including archived channels),
exhausts `files.list` pages and `files.info` comment cursors, downloads original
Slack-hosted bytes, and persists them before emitting `file_documents` records.
It does not follow arbitrary links, capture private channels/DMs, or perform OCR.
Composio and managed-account resolution belong in the hosted adapter, not here.

## Portable operation

Use the binding/S3 configuration from `connector-indexing.md`, add `cutoff` as an
epoch-millisecond integer, and supply your own Slack user OAuth token with the
required read scopes (`channels:read`, `files:read`). The token must belong to the
intended workspace and be authorized for the configured public-channel policy.
Do not put the token in the config file or source control.

```sh
# SLACK_TOKEN is supplied securely through the operator's environment.
node src/connectors/slack-source-standalone.mjs config.json stable-run-id
node src/connectors/standalone.mjs index config.json
node src/connectors/standalone.mjs search config.json 'phrase near document end'
```

Reusing the run ID and cutoff resumes the checkpoint. New runs retain a connection
catalog of previously observed file shares, including shares discovered only by
`files.info`, so removed shares and newly inaccessible
files can be hidden. A complete public-channel enumeration hides prior channels
that are no longer returned. This is an access observation, not permanent deletion.
A denied file remains an explicit coverage failure even when its old content is
hidden. Do not infer deletion from absence in incremental source data.
When upgrading an existing index, use the shared
[catalog seeding operation](slack-message-capture.md#upgrade-existing-access-catalogs)
to preserve channel and file-share identities that older catalogs may have missed.

For durable operation, build `buildSlackSourceWorkflows`, then run
`createSlackSourceWorker` from the `connectors/slack-source-temporal` export.
Schedule `captureSlackFilesV1` with trusted opaque connection references only.
The resolver supplies `{binding, store, request, download}` after current
server-side authorization; every write rechecks it. One workflow at a time may
advance each connection; use overlap SKIP. The workflow uses durable timers for
rate limits, persists request reservations before sending, retries activities,
and continues as new every 100 steps. Source
bodies, API responses, credentials and checkpoint contents stay out of history.

Channel enumeration and each file's comment cursor use the shared pagination
guard. Their scoped run/cutoff checkpoint stores one anchor token and decimal
counters per cursor stream, including across 100-step continuations. Advancing
empty pages remain valid; cycles are rejected before the offending raw page or
derived record is written. Retries retain the previous cursor/progress and the
existing pacing reservation. Terminal cursors clear progress. Legacy checkpoints
initialize from their saved cursor; a rollback may carry progress unchanged until
updated capture code resumes. These failures use the existing nonretryable
`InvalidSlackSource` activity boundary without changing workflow commands.

## Storage and publication contract

All keys are relative to the authorized connection's `rawPrefix`:

- `files/sha256/<sha256>.bin`: immutable original bytes.
- `stream=file_documents/date=YYYY-MM-DD/sync=<run-id>/<hash>.jsonl.gz`:
  envelopes with integer `_airbyte_extracted_at` and `_airbyte_data` version 1.
- `capture/files-v1/<run-id>/pages/<hash>.json`: exact API response evidence.
- `capture/files-v1/<run-id>/state.json`: mutable cursor/rate/checkpoint state.
- `capture/files-v1/catalog.json`: previously observed file/channel identities.

A file record contains `format_version: 1`, native `id`, `channel_id`, boolean
`available`, `media_type`, optional title/name/user and `api_text: [{path,text}]`.
Text-bearing downloaded files additionally require `content_key`, `content_sha256`
and `content_bytes`. The key must equal the scoped SHA-256 blob path; the indexer
checks both checksum and length. Image files retain API metadata/alternative text
without fetching or OCRing image pixels. Unavailable records publish no chunks.

The reference HTTP adapter verifies `auth.test` workspace identity before source
reads. A file comment count greater than the captured comments fails explicitly.

The parser supports UTF-8 text/Markdown/JSON/XML/YAML, Slack canvas HTML, and PDF
text layers. Generic `application/octet-stream` bodies are accepted as text only
when they decode as valid UTF-8 without binary control characters. HTML entities, visible inline text and image alternative text are
retained. PDF extraction visits every page, annotations/form values, structure
alternative text and selected document metadata. Font fragments are joined using
geometry, and a separate dehyphenated text variant aids search across line wraps.
Original extracted page text is retained. PDF reading order is an interpretation;
independent extraction comparison should classify whitespace/layout differences
instead of treating every token difference as omitted content.

Limits are explicit failures: 20 MiB source files, 1,000 PDF pages, 16 MiB extracted
text, and 20,000 extracted parts. Parsing uses a disposable worker thread with a
60-second timeout and V8 heap limits; it is not a security sandbox. Unsupported,
corrupt, encrypted/unreadable or oversized documents never receive a successful
index receipt. A PDF without an accessible text layer has `no-text-layer` status;
that does not assert it is visually blank. No OCR is attempted.

Text chunks have exact source-part offsets and bounded overlap. Reconstructing
non-overlap portions must recover each extracted part exactly. Chunk identities
include the content/extraction revision. Every chunk must commit before the file
manifest publishes that revision. Search requires a current available, unsuppressed
manifest and a current public-channel record, so shorter edits, older retries and
suppression cannot expose stale chunks. Index receipts count source file records,
not the number of chunks produced.

## Acceptance evidence

Test source pagination, comment tails, Retry-After, wrong workspace/prefix,
revocation, missing shares, original-byte hashes, all PDF pages, full Unicode
reconstruction, partial writes, shorter updates, old replay, suppression, and
suffix retrieval beyond previews. Core CI includes customer-operated in-memory
contract tests plus real Temporal and disposable S3/OpenSearch tests.

Production evidence must separately reconcile the independent source inventory,
landed originals/envelopes, parser parts, chunk offsets/hashes, receipts and
user-authenticated search. Successful landed-data indexing does not prove that
all source files or messages were captured. File capture complements message
capture; it does not establish complete channel/thread history. Provider API
limits, permissions and retention still define what can be observed, and changes
are visible only after the next successful capture/index pass.
