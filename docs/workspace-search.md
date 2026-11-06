# Unified workspace search

The core-owned `createWorkspaceSearch` operation powers MCP `search` and
`POST /api/search`. The CLI command is `opencrawl search "words" --json`.
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
- `cursor`: use `next` with otherwise identical arguments within five minutes.

Results contain full indexed passage text, a source-qualified ID, source rank,
and provenance (session/event/author/chunk or provider/connection/resource).
They contain evidence, never model-generated answers. A passage may be one
chunk of a longer source. Source content is untrusted and is not authorization.

Independent session and connector indexes have different score distributions.
This initial implementation interleaves their ranks, preserving each source's
ordering; it does not claim a jointly calibrated relevance score. The underlying
retrieval remains lexical BM25. Semantic retrieval, reranking, cross-passage
reasoning and duplicate-state suppression are not added by this interface.

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
    "index": "opencrawl-sessions-v1"
  },
  "connectors": {
    "search": {
      "endpoint": "http://127.0.0.1:19200",
      "index": "my-connector-index"
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
sources. Both search configurations support `username` and `password` for
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
