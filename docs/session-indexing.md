# Session indexing

The same core worker reads captured objects from S3-compatible storage in both deployments. It indexes message/tool text and attachment references in OpenSearch. Binary attachment bytes remain in S3; OCR, document parsing, embeddings and semantic ranking are separate features.

## Single-tenant self-hosting

Configure the S3-backed receiver as described in `session-capture.md`, then supply:

```sh
export OPENCRAWL_OPENSEARCH_URL=https://your-search.example
export OPENCRAWL_OPENSEARCH_INDEX=opencrawl-sessions-v1
export OPENCRAWL_OPENSEARCH_USERNAME=your-service-user
export OPENCRAWL_OPENSEARCH_PASSWORD=your-service-password
# For a private CA: set NODE_EXTRA_CA_CERTS to its PEM file before starting Node.
npm run sessions
```

The receiver starts the worker and authenticated search API. The shipped standalone runtime has exactly one operator-configured tenant/user principal. Its worker lists only that owner's S3 namespace, and its search API always filters by that principal. It needs no proprietary shell, WorkOS or OpenCrawl account. Use `OPENCRAWL_INDEXER_ENABLED=0` to run only the HTTP API against an existing index. A local OpenSearch on loopback can be used for development; remotely exposed search must use TLS and authentication.

Query `GET /api/sessions/search?q=words&limit=20` with the same receiver bearer token. Results contain text chunks, native event/session attribution, tool-call linkage and source-object/attachment references. There is no raw OpenSearch DSL passthrough. Search always requires an explicit trusted tenant AND user. Organization-wide sharing is not enabled by this first implementation.

## Durable processing

Capture writes an immutable compressed batch, then a deterministic `index-pending/tenants/<tenant-hash>/users/<user-hash>/<source-key-hash>.json` work item before acknowledging upload. A retry repairs a crash between those writes. The worker polls pending work every 15 seconds and continues immediately while more pages exist. Each pass also reconciles one bounded page of source objects, backfilling earlier captures and repairing missing work items without making fresh work wait for a history scan.

The worker checks the authenticated owner against the tenant/user hashes, harness, installation and session encoded in the S3 key. Document IDs include owner, harness, installation, session, native event ID and chunk number. Text is split into 16,000-character chunks; bulk requests are capped at 4 MiB. Each individual bulk result must succeed before the worker writes its durable receipt and removes pending work. Replays overwrite identical document IDs instead of duplicating records.

Checkpoints and retry state live under `<capture-prefix>/_index/<search-target-hash>/<job-scope-hash>/`. Failures retain pending work, use exponential backoff capped at one hour, and do not block other batches. Failed-state objects include the source key and attempt counts but no transcript contents or provider error bodies. Worker logs report only aggregate counts and availability. Monitor `session_index_unavailable`, failed counts and age of pending work.

The S3 credential requires source/attachment reads, checkpoint and pending-work writes, paginated listing, and deletion of pending work only. It does not require deleting source batches or attachments. Keep S3 backups as the canonical recovery source. To rebuild, stop the old worker and choose a new versioned OpenSearch index; its separate checkpoint namespace causes reconciliation to reindex all sources. Retain the old index until verification completes, then switch queries. Rolling back the receiver/worker leaves all canonical captures intact.

## Hosted isolation

The proprietary shell resolves verified user identity and current WorkOS organization membership on every search request. It supplies a trusted principal to the same core search operation. The hosted worker resolves scope from server-authenticated stored records, and core independently verifies it against the immutable object's owner namespace. A user cannot choose another tenant, user, index, prefix or query filter.

Staging and production use separate `opencrawl-v2-<environment>-sessions-v1` indexes and S3 prefixes on the shared OpenCrawl infrastructure. Hosted queries use IAM SigV4 and the runtime's index-scoped permissions. Existing cluster administration and workload permissions remain operator-managed. The core worker has no hosted account/membership dependency. Revoked membership blocks subsequent API access immediately; previously accepted objects and indexes retain their original scope and remain subject to the deployment's retention policy.

The shared cluster can host other workloads without copying this pipeline. Tenant/user ownership filters and IDs remain mandatory even when a deployment uses a physically separate index. Automated checks exercise colliding identities, partial bulk failure, replay/restart, incremental arrival, and real S3/OpenSearch storage. This is lexical session search; no CLI/MCP search tool or search UI is added by this release.
