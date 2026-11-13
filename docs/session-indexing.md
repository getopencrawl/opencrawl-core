# Session indexing with Temporal

The ingest API authenticates the user, validates ownership and the envelope, stores the immutable transcript batch or memory snapshot, and submits that object's key to Temporal before acknowledging it. A retry submits the same durable job even when the raw object already exists. A crash between storage and submission therefore leaves the client queue intact; its next upload completes the handoff. Attachments remain content-addressed objects and are indexed through their transcript batch.

Temporal owns retries and worker outages. Each object uses the existing `indexSessionObject` activity directly, without listing the capture inventory. Work IDs include the trusted source, search/receipt generation and raw object key. Concurrent submissions reuse a running execution; completed submissions reuse the success, and failed executions can be restarted. Transient failures retry without an overall expiration. Permanent scope or document-size failures remain visible in Temporal and require repair. An unavailable Temporal service prevents a remote acknowledgement, while local capture continues to buffer safely. An OpenSearch outage does not prevent submission.

Hosted deployments use standalone Activities on a compatible Temporal service. The bundled self-hosted Temporal 1.29.1 server has no standalone Activity API, so its producer uses `indexSessionObjectV2`, a one-activity compatibility workflow with the same retry policy. This change does not upgrade the server or its database schema. Both runtimes reuse the same activity, validation, visibility controls and indexing receipts.

`indexSessionsV1` remains available for explicit recovery and old histories. Its legacy five-minute schedule stays enabled during a staged upgrade, then is paused after all producers submit directly. `reconcileSessionsV2` performs the one-time catch-up with unlimited transient retries and a durable completion marker. Both scans use bounded pages and continue as new after five pages. Memory indexing may still list one owner's memory controls to enforce visibility; it does not scan captured source objects.

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

The workflow carries only an operator-configured source reference, S3 object keys, cursors and counts. Transcript text and attachment bytes remain in S3. Activities validate each complete event against the same PostgreSQL identity store as capture **before** writing any search chunk, then normalize text and attachment references, validate every OpenSearch bulk item, and only then write an idempotent success receipt. A bypassed receiver or conflicting raw object therefore cannot replace only part of an event. Stable document IDs and deterministic JSON traversal make retry after a partial write safe. Activity failures are sanitized before entering Temporal history.

## Self-hosted application

The [full application](self-host.md) runs its indexing worker alongside the API
with the same object storage, application database and verified organization.
Its bundled Temporal server retains durable workflow state. `npm run app:worker`
is the worker entrypoint for separately orchestrated full-application services;
use the same configuration contract as `deploy/compose.yaml`.

The API binds search and receipt readback to the authenticated user and
organization. It rejects caller-selected tenant/index parameters. Raw batches
retain their authenticated authors, and authoritative visibility controls govern
shared and private reads. Binary attachments stay in S3; OCR and embeddings are
separate features. See [upgrades](upgrades.md) before replacing a running worker.

## Hosted deployment

The proprietary shell binds each worker to one hosted environment, S3 namespace and session index. It resolves owners from server-authenticated stored records; core checks those owners against the tenant/user hashes and session identity in each immutable source key. Every API search independently authenticates the current user and organization membership. Revocation blocks new API access; previously accepted objects remain under their original ownership and retention policy.

Sessions use the same dedicated Temporal service, staging/production namespaces and Node.js worker host as connector indexing. Session task queues and schedules are distinct from Slack's. OpenSearch remains shared OpenCrawl infrastructure with dedicated session indexes. Workflow payloads cannot select a bucket, endpoint, tenant or search target.

## Migration, recovery and operation

### Compaction projection repair (0.2.54)

Indexing keeps explicit compaction summaries (`message` for Codex, `summary` or
`content` for Claude), without traversing replacement history, retained context,
guardian history or bookkeeping. Hook payloads and Codex `user_message`
notifications echo the native transcript and are not indexed. The immutable raw
batches retain all captured evidence, IDs, attachment references and receipts.
`sessionEventData` from `sessions/indexer` exposes this same projection for metering.

Deploy the updated indexing workers before repairing existing documents. Run
`migrateSessionProjection` from `sessions/projection-migration` per tenant, first
with `dryRun: true`, using the canonical capture store/prefix. The operation
validates every affected document against its scoped raw batch, rewrites summary
text, and removes copied higher chunks and echoes. It preserves document IDs and
current privacy; updates do not resurrect a concurrently deleted document.
Missing or mismatched sources fail without changing that page. Supply a durable
`backup` callback and persist `onPage` checkpoints; re-running an interrupted page
is idempotent. `restoreSessionProjection` replays saved pages in reverse. Drain
workers and pause owner visibility/deletion changes before an exact restoration,
then reapply current resource controls before resuming. Raw storage is never deleted.

Existing S3 objects, attachment references and document IDs are unchanged. Successful receipts under `<prefix>/_index/<target-hash>/<scope-hash>/batches/` are reused, avoiding unnecessary reindexing. Legacy `index-pending` objects and S3 retry/cursor state are ignored and never written by the new receiver/worker. They may be retired later under the deployment's retention policy; this migration does not delete them.

Deploy the receiver and worker against the same PostgreSQL identity database.
Existing installations follow the [event identity upgrade](event-identity-migration.md)
for migration, cutover and rollback. Do not delete the search cluster or connector
schedules. Keep session reconciliation enabled until the direct-submission cutover below.

### Direct-submission cutover

Deploy compatible workers first, then API producers with `scheduleIndexing` wired for both transcript batches and memory snapshots. Prove a newly acknowledged object has an accepted Temporal execution and becomes searchable. Keep the old sweep during these stages; worker startup alone cannot establish that all producers have upgraded.

Then call `activateSessionIndexing(client, {sourceId, taskQueue, generation, store, prefix})` from `sessions/temporal-client` using trusted runtime configuration. Derive `generation` with `sessionIndexingGeneration(search.identity, jobId)` in both producer and worker. Activation verifies and pauses the existing sweep, starts/reuses one catch-up workflow, and returns `{workflowId, markerKey, completed}`. If `completed` is false, await `client.workflow.getHandle(workflowId).result()` before declaring the transition complete. The workflow's final retrying activity writes the completion marker only after every page succeeds. Future activation skips completed catch-up even after Temporal history retention expires. No marker means catch-up must run; failed, terminated or expired executions can be restarted by activating again.

Fresh self-host installations set `OPENCRAWL_SESSION_INDEXING_CUTOVER=1` in the generated `deploy/.env`; Compose starts the worker only after the API is healthy. Existing `.env` files omit it and retain the old schedule during rollout. After updating both services and verifying direct submission, set the flag to `1` and restart the worker. Its readiness record exposes `captureCatchup`; verify that workflow completes. Permanent failures leave no completion marker: repair the cause and restart the worker to retry. Keep the flag enabled on subsequent releases.

Explicit repair can run `indexSessionsV1` with an operator-selected workflow ID, or remove only the known completion marker and activate again after diagnosing why a full catch-up is required. New versioned search targets must use a new generation and their matching receipt namespace. Do not reuse completion markers or indexing receipts after rebuilding an index. A producer rollback that stops durable submission must first resume the legacy schedule; retain compatible workers for already accepted work.

Monitor failed executions and retry/backlog age instead of recurring scan activity. Storage credentials still need bounded listing for catch-up, authoritative controls and deletion. Back up canonical S3, the event identity database and Temporal persistence together. Never restore receipts without the matching search index, and never clear deletion controls to make a retry succeed.

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

See [PostgreSQL event identity upgrade](event-identity-migration.md). It replaces
legacy whole-session JSON ledgers, migrates failed-upload reservations as well as
raw history, and provides resumable self-host upgrade and matched backup/restore.
All receivers and workers must use the same database and stable storage namespace.

The older JSON reservation/audit implementation remains available only for
compatibility with package consumers during staged upgrades. Supported standalone
runtimes configure PostgreSQL explicitly. Never omit the adapter after cutover:
legacy code rejects the migration fence rather than creating another authority.

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

## Session deletion upgrade

Stop capture ingress and fully drain all old receiver and indexing processes
before exposing the upgraded console. Older processes do not acquire the new
write fences. After activation, rollback must retain deletion controls and use
fence-aware writers/readers. Never restore an old S3/index backup over current
controls or expose a restored instance before reconciling later deletions.

Every session search reader must receive the canonical `store` and `prefix`
alongside its realm configuration. Missing/unavailable controls fail closed;
search alone cannot establish current visibility. Workers need conditional
read/write access to owner `controls/write-barriers/` objects. These barriers
use linearizable compare-and-set and never expire unresolved remote writes.

The deleting application needs S3 `ListBucketVersions`, `GetObjectVersion`,
`DeleteObjectVersion`, current-object listing, and existing capture/control
read/write permissions, restricted to the capture namespace. Compatible storage
must implement complete version inventory, version deletion, conditional writes
and strong read-after-write/list consistency. No version inventory fallback
pretends that an ordinary DELETE permanently erased a versioned object.
Object Lock, retention holds or denied permissions leave deletion pending and
hidden. Operators can fix those constraints and retry from Sessions.

Preserve the durable fence when diagnosing an uncertain writer. Verify the
recorded process has terminated and the remote operation is conclusively settled
before any operator reconciliation; time passing or a request timeout is not
proof. Never clear a closed fence or tombstone to make a retry succeed.

Attachment uploads now include `harness`, `installationId` and `sessionId`
query parameters. Upgrade clients before enforcement: legacy unscoped uploads
return 409 and retain the local queue. Scoped uploads to a deleted session are
acknowledged and discarded. This operation cannot erase independently copied
backups or unrelated records quoting the same content; operators must apply
retention and deletion policies to those copies separately.

Migration and restore writers also require the canonical store and prefix. They
acquire the same session fences before copying index documents or making
backups. Restoring a deleted session is refused. If an embedding runtime retains
core migration archives, pass their explicit roots through the library
`purgeCopies` callback using `purgeSessionArchives`; all affected versions are
sanitized and permanently removed, preserving unrelated records under their
own session fences. No pre-upgrade migration writer may remain running.
