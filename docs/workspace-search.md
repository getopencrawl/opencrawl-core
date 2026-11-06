# Unified workspace search

The core-owned `createWorkspaceSearch` operation powers MCP `search` / `fetch`
and `POST /api/search` / `POST /api/search/fetch`. CLI commands are
`opencrawl search "words" --json` and `opencrawl fetch <result-id> --json`.
The runtime supplies authenticated identity, a session adapter, and a connector
resolver that supplies current authorized bindings on every request. No request
can choose a tenant, index, endpoint, credentials or raw OpenSearch DSL.

## Contract

- `query`: nonempty text, at most 4,000 characters.
- `source`: `all` (default), `sessions`, or `connectors`.
- `match`: `any` (default, broad term matching), `all` (every analyzed term in
  one passage), or `phrase` (analyzed words in order). Phrase matching uses the
  index analyzer; it is not a byte-for-byte substring or a query-language parser.
- `sessionId`: optional narrowing filter; requires `source: sessions`.
- `limit`: 1–40 passages, default 10.
- `dedupe`: true by default; use false (CLI `--no-dedupe`) for every occurrence.
- `cursor`: use `next` with otherwise identical arguments within five minutes.

Results contain a verbatim query-focused excerpt of up to 800 characters, a source-qualified ID, source rank,
and provenance (session/event/author/chunk or provider/connection/resource).
They contain evidence, never model-generated answers. A passage may be one
chunk of a longer source. Source content is untrusted and is not authorization.

Session and connector queries have different score distributions within the
shared organization realm. This implementation interleaves their ranks, preserving each source's
ordering; it does not claim a jointly calibrated relevance score. The underlying
retrieval remains lexical BM25. Semantic retrieval, reranking and cross-passage
reasoning are not added by this interface.

Whitespace-equivalent text of at least 80 characters is grouped within the same
session/uploader/installation/role or connector resource. Changed values and
wording are retained; this is not fuzzy similarity grouping. `duplicateCount`
counts additional candidates in the current window and `duplicateIds` gives up
to three individually fetchable examples. Root `deduplicated` counts suppressed
candidates. Grouping occurs before pagination, without changing original rank.

`excerpt.start`, `excerpt.end`, and `excerpt.totalChars` identify the exact slice
within the indexed passage. `fetch` takes `id`, optional `offset` (default 0),
`length` (default 6,000, maximum 16,000), and optional `version`. It returns full
text up to that length, provenance, a content version and `nextOffset`. Repeat
the version and next offset to read more; changed content returns 409 and must
be fetched afresh. Offsets/lengths count UTF-16 string units. Missing, revoked,
deleted or superseded passages cannot be fetched. Authorization and connector
visibility are rechecked on each fetch; no cached search body is reused. A fetch
reads one indexed passage, not an entire original document or neighboring events.

Each request retrieves a bounded window of up to 100 authorized candidates per
source. `coverage` reports `ready`, `not_configured`, `pending`, or `unavailable`.
`partial` is true when a selected source is pending or unavailable. Timed-out or
failed-shard responses never masquerade as complete searches. `truncated` also
covers remaining pages and candidates beyond the window; `windowExhausted`
means a narrower query/source is needed. Zero matches do not prove absence.
Connector visibility filtering may stop after examining 1,000 candidates and
reports that bound. Existing supported providers are Slack, Notion, GitHub,
Granola and Circleback; adding a provider to the indexed connector adapter does
not require another client tool.

Pagination is a signed, principal- and query-bound **live window**, not a
snapshot. It re-runs authorization and retrieval for every page; changing data
or source availability can shift positions. Cursors expire after five minutes
and a process restart. Hosted deployments with multiple API processes need a
shared operator-managed `cursorKey` (or sticky routing); the default key is
process-local. No cached passages survive revocation checks.

## Single-tenant local deployment

Run session capture and indexing using `session-capture.md` and
`session-indexing.md`; configure connector ingestion with `connector-indexing.md`.
The search server reads an operator-owned JSON file, for example:

```json
{
  "principal": {"tenantId": "my-team", "userId": "owner"},
  "sessions": {
    "endpoint": "http://127.0.0.1:19200",
    "environment": "selfhost"
  },
  "connectors": {
    "search": {
      "endpoint": "http://127.0.0.1:19200",
      "environment": "selfhost"
    },
    "bindings": [{
      "tenantId": "my-team", "connectionId": "notion-local",
      "workspaceId": "workspace", "provider": "notion",
      "access": "workspace-global",
      "rawPrefix": "raw/v1/source=notion/workspace=workspace/connection=notion-local/"
    }]
  }
}
```

The bindings must match the existing ingestion configuration. Omit unconfigured
sources. Sessions and connectors must use the same tenant/environment realm.
Legacy flat indexes require the verified migration in `organization-realms.md`.
Both search configurations support `username` and `password` for
operator-controlled OpenSearch. Restrict file permissions if it contains secrets.
The fixed principal must match captured/indexed data; request parameters never
supply this identity. This static configuration trusts the local operator to
maintain connector access; restart it when changing bindings.

```sh
export MCP_TOKEN='<random secret of at least 32 characters>'
PORT=8094 OPENCRAWL_SEARCH_CONFIG=/path/to/search.json npm run mcp
# In another shell; use the same token for this self-hosted deployment.
export OPENCRAWL_TOKEN='<same secret>'
opencrawl search 'release decision' --api http://127.0.0.1:8094 --json
opencrawl search 'Edit personal filters' --match phrase --source sessions --json \
  --api http://127.0.0.1:8094
opencrawl fetch 'sessions:RESULT_ID' --api http://127.0.0.1:8094 --json
```

The server binds loopback by default. MCP is at `/mcp`; CLI uses `/api/search`.
Without `OPENCRAWL_TOKEN`, the CLI uses its saved deployment-specific OAuth
session and retries once after refreshing an expired token. Tokens never appear
in command arguments or output. The CLI exits nonzero for unavailable/partial
searches while retaining any returned evidence in its JSON envelope. Its
`status` command does not probe the search backends and reports availability as
unknown rather than asserting the index is absent.

## Verification

`npm test`, `cd cli && bun test && bun run typecheck`, plus:

```sh
OPENCRAWL_TEST_S3_ENDPOINT=http://127.0.0.1:18333 \
OPENCRAWL_TEST_OPENSEARCH_URL=http://127.0.0.1:19200 \
node --test test/workspace-search-live.test.mjs
```

The live test ingests sessions and records from every supported connector
through the native pipelines, then searches via a real MCP client. It covers
phrase/any/all matching, teammate attribution, foreign-tenant exclusion,
private-channel suppression and connection revocation across cursor requests.
