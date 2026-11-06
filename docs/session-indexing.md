# Session indexing with Temporal

The ingest API authenticates the user, validates ownership and the envelope, and stores immutable transcript batches and attachments in S3-compatible storage. Its acknowledgement requires durable S3 storage. It does not create indexing work items, call Temporal, initialize search, or run background processing. A Temporal or OpenSearch outage does not prevent capture.

A separate Node.js worker runs `indexSessionsV1` on Temporal. A five-minute durable schedule discovers captured objects in bounded S3 pages and executes indexing activities. Temporal owns activity retry/backoff, timeouts and the discovery cursor. After five pages a workflow continues as new to bound history. Each activity retries five times; an exhausted object does not block the rest of the sweep, but causes a visible failed workflow. The next scheduled sweep can retry repaired objects. Schedule overlap is SKIP.

The workflow carries only an operator-configured source reference, S3 object keys, cursors and counts. Transcript text and attachment bytes remain in S3. Activities normalize text and attachment references, validate every OpenSearch bulk item, and only then write an idempotent success receipt. Stable document IDs make retry after a partial write safe. Activity failures are sanitized before entering Temporal history.

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
node src/sessions/temporal/standalone.mjs /path/to/session-bundle.cjs --build
node src/sessions/temporal/standalone.mjs /path/to/session-bundle.cjs
```

`npm ci` in the core repository installs the pinned Temporal SDK. Package consumers install the optional `@temporalio/{activity,client,common,worker,workflow}` peers at 1.25.0 explicitly. Use an operator-controlled source ID (`OPENCRAWL_SESSION_SOURCE_ID`, default `self-hosted-sessions-v1`) and dedicated task queue for each fixed source binding. The worker lists and processes only the configured tenant/user namespace. It requires no hosted shell, WorkOS or OpenCrawl account. Stop its worker and pause its exact schedule before changing that fixed authorization policy. Remote services require their normal network/authentication protections; the provided plain connection configuration assumes a private trusted Temporal network.

The API still serves `GET /api/sessions/search?q=words&limit=20` with the receiver bearer token. It always binds the authenticated tenant and returns every teammate's sessions with the original `userId` attribution. Arbitrary search DSL and caller-selected index/tenant are not accepted. `GET /api/sessions/batches` accepts `userId` to select the author of a batch within that tenant; omitting it selects the caller. Uploads still require the authenticated user's own identity. Stored batches retain the authenticated name and email; user subdirectories preserve attribution and write ownership, not private read access. The worker creates the search index when it first processes data. Binary attachments stay in S3; OCR and embeddings are separate features.

## Hosted deployment

The proprietary shell binds each worker to one hosted environment, S3 namespace and session index. It resolves owners from server-authenticated stored records; core checks those owners against the tenant/user hashes and session identity in each immutable source key. Every API search independently authenticates the current user and organization membership. Revocation blocks new API access; previously accepted objects remain under their original ownership and retention policy.

Sessions use the same dedicated Temporal service, staging/production namespaces and Node.js worker host as connector indexing. Session task queues and schedules are distinct from Slack's. OpenSearch remains shared OpenCrawl infrastructure with dedicated session indexes. Workflow payloads cannot select a bucket, endpoint, tenant or search target.

## Migration, recovery and operation

Existing S3 objects, attachment references and document IDs are unchanged. Successful receipts under `<prefix>/_index/<target-hash>/<scope-hash>/batches/` are reused, avoiding unnecessary reindexing. Legacy `index-pending` objects and S3 retry/cursor state are ignored and never written by the new receiver/worker. They may be retired later under the deployment's retention policy; this migration does not delete them.

Deploy the worker before the new receiver. A brief overlap with the old poller is safe because writes and receipts are idempotent. To roll back, pause the exact session schedule, stop its session worker and restore the previous receiver/worker release; canonical S3 objects remain intact. Do not delete the shared search cluster or connector schedules. Future low-latency notifications can trigger the same processing path while retaining periodic reconciliation.

Discovery currently sweeps the fixed source prefix, including successful receipts checks, using bounded pages. This deliberately favors simple reliable catch-up over low-latency ingestion. Monitor schedule failures, activity retries and sweep lag. S3 credentials need source reads/listing and success-receipt reads/writes; source deletion is unnecessary. Back up canonical S3 and Temporal persistence. Rebuild against a new versioned index with its own receipt namespace; never restore receipts without the matching index.

## Raw diagnostics

An authenticated runtime can call `search.search(principal, {query, limit: 20,
raw: true})` on its configured session adapter to receive the OpenSearch response
with `_index`, `_id`, `_score`, `_source`, totals, timing and shard metadata.
Ownership checks still run before returning data. Connector search accepts the
same option with authorized bindings and returns `{responses, examined,
truncated}`. Each response contains only channel-visible hits within the result
limit; pre-visibility totals and maximum scores are omitted. Raw mode does not
accept an index, DSL or alternative principal from the query input.

`renderDebug` from `@1patch/opencrawl-core/debug` and `web/debug.js` / `debug.css`
provide a query box, readable result excerpts, and expandable item/full-response JSON. Load `debug.js` as a module. Query terms are highlighted literally in the displayed text; these highlights are a reading aid, not an OpenSearch analyzer explanation. The embedding runtime must protect
both the page and `POST /api/debug/search`, resolve its own trusted principal,
and provide the shared tokens and layout. This UI performs no identity selection.
