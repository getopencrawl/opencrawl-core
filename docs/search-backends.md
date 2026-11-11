# Search index adapters

OpenCrawl's agent-facing MCP, HTTP and CLI `search` and `fetch` interfaces are
the same for OpenSearch and SQLite FTS5. The application continues to own source
authorization, current resource visibility, grouping, excerpts, facets and
pagination. Backend configuration is operator-owned, never request input.

**API compatibility does not guarantee matching, scoring or ranking parity.**
The adapters share a small conformance floor. Tokenization, relevance order,
scores, aggregation implementation and performance can differ. Unsupported
SQLite query operations fail explicitly instead of dropping a constraint.

## Selecting SQLite

OpenSearch remains the default. For a **new**, single-host installation, set:

```sh
OPENCRAWL_SEARCH_URL=sqlite:///data/search.sqlite
```

The URL must be an absolute local file path, with no hostname, credentials,
query or fragment. Both API and worker must use the same path and persistent
volume. SQLite needs no separate search service or additional npm dependency;
it uses Node 24's built-in `node:sqlite` with FTS5. Do not put the database on a
network filesystem or share it between hosts.

For the application Compose stack, first generate/configure `deploy/.env` using
the existing setup instructions, then run from `deploy/`:

```sh
docker compose -f compose.yaml -f compose.sqlite.yaml up -d --build --wait
```

The override selects SQLite for app and worker and excludes the OpenSearch
service. It requires Compose support for `!override` (2.24.4 or later).
Use the same file arguments for subsequent stop/start and maintenance commands.
S3-compatible source storage and Temporal are still required; this changes only
the derived search index. Existing quickstart installations continue using
OpenSearch unless explicitly configured otherwise.

Operator JSON search configurations can set the same URL in their existing
`endpoint` field. In code:

```ts
const realm = createRealm({
  endpoint: 'sqlite:///var/lib/opencrawl/search.sqlite',
  environment: 'selfhost',
  tenantId: trustedPrincipal.tenantId,
});
await realm.ensureIndex();
```

`OPENCRAWL_SEARCH_URL` takes precedence over `OPENCRAWL_OPENSEARCH_URL`.
Existing HTTP(S) endpoints, OpenSearch credentials and cloud routing retain
their behavior. SQLite rejects remote credentials and replica configuration.

## Adapter contract

`SearchRealm` and `SearchCollection` in `src/search/types.mts` define the internal
index boundary. It retains the existing realm query/hit vocabulary to minimize
changes to product callers. It is a supported subset of the current internal
OpenSearch-shaped requests, **not an OpenSearch protocol emulator**.

- One tenant/environment realm, common document envelope and collision-safe
  corpus IDs. Every operation rejects a foreign or capture-only principal.
- Search, exact document lookup, bulk writes, delete by IDs, scoped mutation,
  index initialization and a search-visibility barrier (`refresh`).
- Named `session`, `connector`, `memory-head` and `session-projection` write
  policies preserve ownership, replay ordering and connector tombstones.
  OpenSearch compiles them to its existing Painless scripts; SQLite evaluates
  them within a writer transaction. Ordinary product callers use policies and
  field patches. Legacy raw scripts remain OpenSearch-only.
- The shared contract tests check lexical modes on simple fixtures, exact
  filters, ranges, sorting/continuation, scope, lookup, replacement, deletion,
  stale-write handling and suppression. They do not assert equal scores or
  result ordering between engines.

SQLite supports the product's `match_all`, `match_none`, Boolean, term/terms,
range, exists, keyword wildcard and lexical queries; field ordering and
`search_after`; filter, terms/multi-terms, min/max, cardinality, value-count,
daily date-histogram and top-hits aggregations. The adapter rejects unknown
operators, fields and options. This vocabulary should grow alongside real
product requirements and adapter conformance coverage.

## SQLite behavior and operation

FTS5 uses `unicode61` tokenization, case folding and no stemming or diacritic
removal. Query text is treated literally, without exposing FTS query syntax.
Title and board-topic columns have weight 2; body text has weight 1. FTS5 BM25
scores are converted so higher is better. Tokenization and scoring differ from
OpenSearch's analyzer and BM25 implementation; scores are not comparable.
Each realm has its own FTS table, including corpus-wide term statistics.

SQLite commits are immediately visible to later readers. WAL supports API and
worker processes on one machine, with a five-second busy timeout and one writer
at a time. Each operation closes its connection. Bulk writes are atomic in
SQLite; OpenSearch bulk failures can have partially applied items. Application
retry and authoritative visibility checks remain required for both.

SQLite computes exact SQL counts/cardinality for supported aggregations.
Workspace facets still describe the authorized candidate window, as before.
Aggregation output is bounded to 10,000 buckets per request; oversized requests
fail explicitly. SQLite work is synchronous in the process, so expensive
queries or writer contention can affect API latency. This adapter targets
smaller single-host installations; no throughput or corpus-size guarantee is
implied by the conformance suite.

The index uses an application ID and schema version and rejects unrelated or
unsupported SQLite files. A newly created file is mode 0600. Back up/restore the
application volume with API and worker stopped, including any SQLite WAL files;
follow the existing cold-backup process. Do not copy only the main database file
while writers are active. Keep source storage and resource controls in backups.
For the existing backup tool, retain the profile with
`COMPOSE_FILE=compose.yaml:compose.sqlite.yaml node deploy/backup.mjs create /absolute/backup-directory`
and the same `COMPOSE_FILE` when restoring and restarting.

Changing an existing deployment's backend does **not** migrate its index.
Build a fresh target by replaying retained sources with appropriate fresh
indexing checkpoints, verify coverage and authorization, then switch all readers
and writers together. Automatic backend migration is outside this adapter's
scope. Preserve the prior index, configuration and source data for rollback;
resume/catch up its indexing before reverting after additional captures.

## Verification

```sh
npm test
OPENCRAWL_TEST_OPENSEARCH_URL=http://127.0.0.1:19200 \
  node --test test/search-adapter-conformance.test.mjs
```

The conformance suite runs SQLite unconditionally and OpenSearch when that
explicit test endpoint is supplied. CI runs both against a disposable real
OpenSearch instance. `test/sqlite-search.test.mjs` additionally exercises a real
MCP client, native session ingestion, connector revocation, privacy, durable
reopening, atomic rollback, board facets and usage/library aggregations.

Engine references: [SQLite FTS5](https://www.sqlite.org/fts5.html) and
[Node SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).
