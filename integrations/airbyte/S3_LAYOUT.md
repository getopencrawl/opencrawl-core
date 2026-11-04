# S3 landing layout

Every connection created with `cli.mjs connect` writes to one S3 destination,
`OpenCrawl landing`. Whatever the source (GitHub, Slack, Notion, Google Drive, a
database), records land in the same bucket with the same layout and record format.
This document is the contract for anything that reads them, such as an OpenSearch
indexer.

It describes Airbyte's S3 destination 1.9.11 on Airbyte 2.4.0, configured by
`cli.mjs` for uncompressed JSONL with no flattening.

## Keys

```
s3://<OPENCRAWL_LANDING_S3_BUCKET>/<OPENCRAWL_LANDING_S3_PATH>/<source>/<stream>/<YYYY>_<MM>_<DD>_<epoch_ms>_<part>.jsonl
```

| Segment | Meaning |
| --- | --- |
| `OPENCRAWL_LANDING_S3_PATH` | Root prefix, `opencrawl` by default |
| `<source>` | The connection's namespace: the `--name` given to `connect` (or the source type), lowercased, with runs of other characters replaced by `_` and leading or trailing `_` removed. For example, `--name "Acme GitHub"` becomes `acme_github`. `connect` refuses a name whose prefix is already used, empty or `testing`, so each prefix belongs to exactly one source |
| `<stream>` | The connector's stream name, such as `issues`, `pull_requests`, `channel_messages` or `pages` |
| `<YYYY>_<MM>_<DD>_<epoch_ms>` | UTC date and epoch milliseconds of when that sync started writing. The value is shared by every stream in one sync |
| `<part>` | Starts at `0`. Large streams are split across several objects |

Example:

```
opencrawl/acme_github/issues/2026_11_04_1793815176400_0.jsonl
opencrawl/acme_github/issues/2026_11_04_1793815176400_1.jsonl
opencrawl/acme_slack/channel_messages/2026_11_04_1793815180112_0.jsonl
```

Objects are written once and never modified. That makes them safe to process from
S3 event notifications.

When a destination is created or tested, Airbyte's connection check wrote small
objects under `<OPENCRAWL_LANDING_S3_PATH>/testing/` in our runs (this isn't in
Airbyte's docs). Readers should ignore that prefix, and `testing` should not be
used as a source name.

`<OPENCRAWL_LANDING_S3_PATH>/agent-sessions/` belongs to the agent-sessions
integration, which has its own format (see `../agent-sessions/README.md`).
Airbyte prefixes never contain `-`, so they can't collide with it.

Each object carries the metadata `x-amz-meta-ab-generation-id`, which matches
`_airbyte_generation_id` in its records.

## Records

One JSON object per line:

```json
{
  "_airbyte_raw_id": "01a1a7b7-6795-7d03-a349-361a2483bf79",
  "_airbyte_extracted_at": 1793815176735,
  "_airbyte_meta": {"sync_id": 7, "changes": []},
  "_airbyte_generation_id": 4,
  "_airbyte_data": {"id": 1, "make": "Mazda", "model": "MX-5", "updated_at": "2026-11-04T17:59:36+00:00"}
}
```

| Field | Meaning |
| --- | --- |
| `_airbyte_raw_id` | Unique ID for this copy of the record. A new value is assigned on every sync |
| `_airbyte_extracted_at` | When the record was read from the source, in epoch milliseconds |
| `_airbyte_meta.sync_id` | Increases with each sync. Airbyte gives it no other meaning, so don't depend on its value |
| `_airbyte_meta.changes` | Fields Airbyte nulled or truncated, for example because they were too large or failed to parse. Usually empty |
| `_airbyte_generation_id` | Increments each time a stream is fully refreshed. Used to tell current snapshots from older ones |
| `_airbyte_data` | The record exactly as the connector emitted it. Its shape depends on the connector and stream |

`GET /api/public/v1/streams?sourceId=…&destinationId=…` lists each stream's
fields, primary key (`sourceDefinedPrimaryKey`), cursor and supported sync
modes. The full JSON schema comes from `POST /api/v1/sources/discover_schema`
with `{"sourceId": "…"}`. Connector docs at
https://docs.airbyte.com/integrations/sources/ list the streams.

File-based sources, such as Google Drive, OneDrive, SharePoint and S3, can parse
documents into text. Configure their streams with
`"format": {"filetype": "unstructured"}` so each record carries the document text
in `content`, with `document_key` identifying the file.

## Sync modes

Each stream in a connection has a sync mode, and it decides what a new object
means. `cli.mjs connect` accepts Airbyte's defaults; in testing that was
`full_refresh_overwrite` for every stream. Modes can be changed per stream with
`PATCH /api/public/v1/connections/{id}`.

| Mode | What each sync writes | What the reader must do |
| --- | --- | --- |
| `full_refresh_overwrite` | A complete snapshot with a new generation ID. After the sync succeeds, objects from older generations are deleted | Treat the newest generation as the full truth. After indexing it, delete indexed documents from older generations |
| `full_refresh_append` | A complete snapshot. Older snapshots stay | Each sync is a complete copy; use the newest `epoch_ms` in the key as the current snapshot. Older objects are never cleaned up |
| `incremental_append` | Only records that are new or changed since the last sync, based on the stream's cursor | Upsert by primary key and keep the latest `_airbyte_extracted_at`. API sources don't report records deleted at the source. Database sources using CDC do, as records with `_ab_cdc_deleted_at` set |

Airbyte's S3 destination does not support deduplicated modes, so duplicates
across objects are normal and the reader deduplicates them.

## Indexing into OpenSearch

A reader that follows this contract:

1. **Discover new objects.** Use S3 event notifications (`s3:ObjectCreated:*`),
   or list `<root>/<source>/<stream>/` and track which keys have been processed.
2. **Choose a document ID.** Use `<source>/<stream>/<primary key>`, so a record
   that changes overwrites its earlier version. Fall back to `_airbyte_raw_id`
   only for streams without a primary key.
3. **Keep `source`, `stream`, `_airbyte_generation_id` and `_airbyte_extracted_at`
   on each document.** They are needed for filtering, recency and cleanup.
4. **Handle full refreshes.** When a stream's generation ID increases, index the
   new snapshot, then run `delete_by_query` for that source and stream with
   `_airbyte_generation_id` below the new value. This is also the only way to drop
   records deleted at the source. For incremental streams, schedule an occasional
   full refresh to do the same.
5. **Map `_airbyte_data` to searchable text per stream.** Examples: issue title and
   body, message text, page content. Keep the original as a stored field.

## What was verified

These were checked against Airbyte 2.4.0 writing to a local S3-compatible store
(SeaweedFS):

- the key layout, record format and object metadata
- `incremental_append` and `full_refresh_append`

`full_refresh_overwrite` wrote its objects correctly, but on SeaweedFS the
cleanup step also deleted the new generation. That is most likely a gap in that
store's metadata handling. Confirm overwrite cleanup on real S3 before relying
on it.
