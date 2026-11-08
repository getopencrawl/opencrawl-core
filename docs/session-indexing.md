# Session indexing with Temporal

The ingest API authenticates the user, validates ownership and the envelope, and stores immutable transcript batches and attachments in S3-compatible storage. Its acknowledgement requires durable S3 storage. It does not create indexing work items, call Temporal, initialize search, or run background processing. A Temporal or OpenSearch outage does not prevent capture.

A separate Node.js worker runs `indexSessionsV1` on Temporal. A five-minute durable schedule discovers captured objects in bounded S3 pages and executes indexing activities. Temporal owns activity retry/backoff, timeouts and the discovery cursor. After five pages a workflow continues as new to bound history. Each activity retries five times; an exhausted object does not block the rest of the sweep, but causes a visible failed workflow. The next scheduled sweep can retry repaired objects. Schedule overlap is SKIP.

Session and connector sweeps detect cyclic provider cursors across continuations.
The workflow retains one checkpoint token and two decimal counters (constant
token count, logarithmic counter bytes), with no page-count ceiling. Advancing
pages containing only filtered objects still count as progress. On a cycle, the
workflow finishes the current page and passes a fixed failure code to its next
existing list activity, continuing as new first when the segment ends. The list
activity rejects with nonretryable `SourcePaginationFailed` before accessing the
provider. No extra activity is added after a terminal page.

Failure remains at the existing activity boundary so old and new workflow code
replay the same command sequence, including rolling updates and rollback. Legacy
workers may ignore the additive checkpoint/failure fields and carry stale state
across continuations; new workers resume checking that state when they take over.
Cycle enforcement requires the updated workflow and activity implementations.
A legacy activity may ignore a pending failure and finish on a terminal provider
page; the workflow does not add an extra call just to enforce that failure.
The standalone shared runner instead reports pagination errors immediately.

The workflow carries only an operator-configured source reference, S3 object keys, cursors and counts. Transcript text and attachment bytes remain in S3. Activities validate each complete event against the same conditional identity ledger as capture **before** writing any search chunk, then normalize text and attachment references, validate every OpenSearch bulk item, and only then write an idempotent success receipt. A bypassed receiver or conflicting raw object therefore cannot replace only part of an event. Stable document IDs and deterministic JSON traversal make retry after a partial write safe. Activity failures are sanitized before entering Temporal history.

## Single-tenant self-hosting

Run the receiver with the S3 settings and bearer token in `session-capture.md`. Run Temporal with persistent storage separately. The worker uses the same S3 settings plus:

```sh
export OPENCRAWL_TENANT_ID=my-team
export OPENCRAWL_USER_ID=owner
export OPENCRAWL_OPENSEARCH_URL=https://your-search.example
# Optional: OPENCRAWL_OPENSEARCH_INDEX names the organization realm shared by all sources.
export OPENCRAWL_OPENSEARCH_USERNAME=your-service-user
export OPENCRAWL_OPENSEARCH_PASSWORD=your-service-password
export TEMPORAL_ADDRESS=your-temporal:7233
export TEMPORAL_NAMESPACE=your-existing-namespace
export TEMPORAL_SESSION_TASK_QUEUE=session-indexing-v1
# Build once with the released worker code, then run independently of the API.
node dist/src/sessions/temporal/standalone.mjs /path/to/session-bundle.cjs --build
node dist/src/sessions/temporal/standalone.mjs /path/to/session-bundle.cjs
```

`npm ci` in the core repository installs the pinned Temporal SDK. Package consumers install the optional `@temporalio/{activity,client,common,worker,workflow}` peers at 1.25.0 explicitly. Use an operator-controlled source ID (`OPENCRAWL_SESSION_SOURCE_ID`, default `self-hosted-sessions-v1`) and dedicated task queue for each fixed source binding. The worker lists and processes only the configured tenant/user namespace. It requires no hosted shell, WorkOS or OpenCrawl account. Stop its worker and pause its exact schedule before changing that fixed authorization policy. Remote services require their normal network/authentication protections; the provided plain connection configuration assumes a private trusted Temporal network.

The API still serves `GET /api/sessions/search?q=words&limit=20` with the receiver bearer token. It always binds the authenticated tenant and returns every teammate's sessions with the original `userId` attribution. Arbitrary search DSL and caller-selected index/tenant are not accepted. `GET /api/sessions/batches` accepts `userId` to select the author of a batch within that tenant; omitting it selects the caller. Uploads still require the authenticated user's own identity. Stored batches retain the authenticated name and email; user subdirectories preserve attribution and write ownership, not private read access. The worker creates the search index when it first processes data. Binary attachments stay in S3; OCR and embeddings are separate features.

## Hosted deployment

The proprietary shell binds each worker to one hosted environment, S3 namespace and session index. It resolves owners from server-authenticated stored records; core checks those owners against the tenant/user hashes and session identity in each immutable source key. Every API search independently authenticates the current user and organization membership. Revocation blocks new API access; previously accepted objects remain under their original ownership and retention policy.

Sessions use the same dedicated Temporal service, staging/production namespaces and Node.js worker host as connector indexing. Session task queues and schedules are distinct from Slack's. OpenSearch remains shared OpenCrawl infrastructure with dedicated session indexes. Workflow payloads cannot select a bucket, endpoint, tenant or search target.

## Migration, recovery and operation

Existing S3 objects, attachment references and document IDs are unchanged. Successful receipts under `<prefix>/_index/<target-hash>/<scope-hash>/batches/` are reused, avoiding unnecessary reindexing. Legacy `index-pending` objects and S3 retry/cursor state are ignored and never written by the new receiver/worker. They may be retired later under the deployment's retention policy; this migration does not delete them.

For releases that already enforce immutable event IDs, deploy the worker before
the new receiver. The first enforcement release requires the quiescent upgrade
below; an old receiver or worker must not write alongside a new ledger. Do not
delete the shared search cluster or connector schedules. Future low-latency
notifications can trigger the same processing path while retaining periodic
reconciliation.

Discovery currently sweeps the fixed source prefix, including successful receipts checks, using bounded pages. This deliberately favors simple reliable catch-up over low-latency ingestion. Monitor schedule failures, activity retries and sweep lag. S3 credentials need source reads/listing, conditional event-ledger reads/writes and success-receipt reads/writes; source deletion is unnecessary. Back up canonical S3 and Temporal persistence. Rebuild against a new versioned index with its own receipt namespace; never restore receipts without the matching index.

## Installation-independent document IDs (0.2.39)

A session document ID is derived from the author, harness, session, event ID and
chunk, and no longer from the uploading installation. Event IDs are content
hashes, so the same native record uploaded from a second install or a cloned
machine overwrites its document instead of adding a copy that Usage counts twice.

Realms indexed before 0.2.39 keep their older IDs and may already contain such
copies. After deploying the new worker, run `migrateSessionDocumentIds` from
`@getopencrawl/opencrawl-core/sessions/document-identity` once per tenant, first
with `dryRun: true`. It scans the session corpus in native-position order, keeps
one copy of each record (preferring the current `wire1:` event format) under its
new ID, and removes the rest. Copies count as the same record only when their
position, tool fields and the sorted lines of their full text match, which
tolerates older indexers' key order and chunking without merging distinct
records. Each step passes its new IDs and removed documents to `backup` before
writing; `restoreSessionDocumentIds` replays stored steps in reverse to restore
the prior documents exactly. Runs are idempotent and resume from `report.after`.

## Immutable event-ID activation

Older receivers accepted different event content under the same ID. Since chunk
IDs are stable, shortening such an event could leave higher chunks from its older
content searchable. The new receiver prevents reuse, and the worker rejects
conflicting raw input before search writes. Historical successful receipts are
still reused, so a complete raw-source audit is required before activating the
first enforcing release. The audit does not silently select a winning revision
or repair an already mixed index.

1. Run the read-only audit using the candidate release and the existing receiver's
   storage and fixed identity environment. This can run during normal operation
   for diagnostics, but its results are not a cutover proof while writers run:
   `node dist/src/sessions/audit.mjs`.
2. Pause the exact session-indexing schedule and drain/stop its workers, including
   already running activities. Stop accepting capture requests and drain/stop
   every old receiver. Also stop any direct source writer. Preserve client queues;
   clients will retry. Leave connector workers and unrelated schedules alone.
   Do this **before** starting any candidate worker, because workers also create
   ledgers. A rolling overlap of old and new capture code is unsafe here.
3. With the source quiescent, run `node dist/src/sessions/audit.mjs --initialize`.
   Require a successful exit, `conflicts: 0` and `initialized === sessions`.
   The command inventories all accepted raw batches, including batches with
   existing indexing receipts, and reserves their identities using compare-and-set.
   It is idempotent, preserves prior reservations, and never deletes source or
   search data. An empty source returns zero sessions and is a valid result.
4. If any conflict, malformed object, scope mismatch, inventory failure or capacity
   limit occurs, keep capture/indexing paused and resolve it before activation.
   Conflict output contains only session/event identity hashes; investigate under
   authorized access without copying transcript content to deployment logs.
   A conflict requires an explicit repair plan covering raw history and already
   indexed chunks; re-running the audit cannot bless a selected winner.
5. Start the new receiver and workers, restore the previous schedule pause state,
   and verify accepted/retried captures, rejected changed-ID uploads, and indexing
   completion. Keep the zero-conflict audit report as release evidence.

For hosted adapters, the same public
`auditSessionEventSource({store, prefix, resolvePrincipal, initialize})` export
from `@getopencrawl/opencrawl-core/sessions` uses the trusted stored-owner resolver used
by indexing. A fixed single-tenant adapter instead passes `principal`. Supply
exactly one; request input cannot supply either. The report contains only counts
and up to 100 hashed conflict identities. Its lower-level
`auditSessionEventIdentities` audits one fully specified session. Write-only
capture principals cannot invoke audits. An initialization run may initialize
earlier clean sessions before encountering a later conflict; that is safe to
retry, but the **whole-source** gate must pass before resuming writers.

Bootstrap reads at most 10,000 raw batches and 1,000 inventory pages per session
and uses the same 16 MiB ledger bound as capture. Whole-source audit supports at
most 100,000 sessions and 10,000 inventory pages per configured scope. Pages
contain at most 100 keys; ignored keys and empty continuation pages also consume
the page budget. Exceeding a bound fails closed rather than auditing a partial
history. On a new session, capture/indexing automatically initialize the absent
ledger from all historical raw batches, but this is safe only after all old
writers are drained. A compatible object store must provide strongly consistent
listing, bounded `get`/`readVersion` and atomic `compareAndSet` (S3 ETag/If-Match
and If-None-Match). Plain last-write-wins stores are rejected. The included S3
adapter supplies this contract for self-hosted and hosted deployments.

Rollback preserves raw batches, receipts and ledgers. Restoring an older enforcing
release is safe with the usual worker drain. Do not resume a pre-enforcement
receiver/worker against initialized ledgers: it could publish unreserved edits.
If such a rollback is unavoidable, keep writes paused until a compatible fix is
available; any period of old writes requires another quiescent full-source audit
before reactivation. Never delete ledgers to bypass a conflict or capacity limit.

## Raw diagnostics

An authenticated runtime can call `search.search(principal, {query, limit: 20,
raw: true})` on its configured session adapter to receive the OpenSearch response
with `_index`, `_id`, `_score`, `_source`, totals, timing and shard metadata.
Ownership checks still run before returning data. Connector search accepts the
same option with authorized bindings and returns `{responses, examined,
truncated}`. Each response contains only channel-visible hits within the result
limit; pre-visibility totals and maximum scores are omitted. Raw mode does not
accept an index, DSL or alternative principal from the query input.

The React `SearchInspector` exported by `@getopencrawl/opencrawl-core/web-v2`
provides a query box, readable result excerpts, and expandable item/full-response JSON. Query terms are highlighted literally in the displayed text; these highlights are a reading aid, not an OpenSearch analyzer explanation. The embedding runtime must protect
both the page and `POST /api/debug/search`, resolve its own trusted principal,
and provide the shared tokens and layout. This UI performs no identity selection.
