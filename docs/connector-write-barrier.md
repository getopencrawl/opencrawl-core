# Connector write and deletion barrier

The core `connectors/write-barrier` export coordinates native writes with deletion
using the existing S3-compatible `readVersion` / `compareAndSet` contract. Those
operations must provide linearizable conditional replacement and creation; see
[AWS conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).
`guardConnectorWrites({binding, store, search, namespace})` supplies wrapped S3
`put`/`compareAndSet` and search `putDocuments`/`suppress` methods. It checks the
connection scope before acquiring an intent. Use the guarded adapters for every
native writer, including repair jobs and retries. Standalone capture/indexing
entrypoints and hosted native resolvers do this automatically.

Each write registers an intent before starting I/O, observes successful completion,
persists a `settled` acknowledgment and removes completed intents. A lost control
response is retried with the same operation ID. A closer can remove durable
`settled` records after a worker restarts. A trusted adapter may reject with
`error.writeOutcome = 'not-applied'` only when it positively proves no mutation
started or the service refused the whole operation. The barrier durably settles
that refusal, then preserves the original error. Reference adapters use this for
local preflight validation, credential resolution before dispatch, recognized S3
single-PUT refusals and top-level OpenSearch authentication/authorization refusals.
A status code or `permanent` flag alone never establishes this contract.

Other data-write errors/cancellation remain uncertain because a remote request
might still commit. In particular, [OpenSearch bulk actions are independent](https://docs.opensearch.org/latest/api-reference/document-apis/bulk/), so partial or malformed bulk results remain pending; they are not classified
as no-mutation refusals. The [S3 PutObject contract](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)
provides the single-operation conditional and validation refusals used by the
reference object adapter. Unknown errors and 5xx remain pending.

`createConnectorWriteBarrier({tenantId, connectionId, store, namespace}).close()`
irreversibly closes admission for that connection incarnation and returns its
pending writers. Delete raw/index data only after `closed === true` and
`pending === 0`. Repeated close is idempotent and recovers settled acknowledgments.
There is no reopen operation. Reconnection must use a new connection ID.

The hashed document lives under `control/connectors/write-barriers/v1/`, outside
raw and derived data prefixes. Its identity includes deployment namespace, tenant
and connection. Preserve this document through deletion, retention policies and
rollback. Store grants should allow exact Get/Put access to this control prefix
without Delete access. The current reference S3 adapter supplies the required
conditional methods; local unit tests and real S3-compatible CI exercise races
between independent adapter instances.

State is bounded to 128 simultaneous unresolved writes and 2 MiB, with bounded
operation IDs, target metadata and process-instance IDs. Exhaustion denies new
writes. `inspect()` exposes operation ID, target object key or bounded search
operation summary (document count and SHA-256 of ordered IDs), writer instance,
start time, phase and positive settlement time when available. Reconstruct a
search batch from the source operation/checkpoint and verify the digest; the
control document is deliberately not an unbounded document manifest.
The worker instance can be included in operator readiness/log metadata.

No wall-clock expiry, activity timeout, cancellation, or dead process releases an
uncertain write. [Temporal cancellation is cooperative](https://typescript.temporal.io/api/namespaces/activity#cancellation); it does not establish storage-write completion. A crash after data success but before durable acknowledgment can
therefore require operator reconciliation. The same applies if every retry to
persist the initial settlement acknowledgment fails, even though that process
observed success. A persisted settled acknowledgment recovers automatically;
there is no automatic recovery based on age or absence of a worker. This is a deletion-liveness limit,
not permission to claim deletion: retain the closed tombstone and pending state
until the exact operation has verified completion. Existing deployments must
positively drain unguarded old writers before treating an empty new barrier as
proof. The barrier coordinates native writers only; separately operated importers
must establish their own stop/drain contract before their output is deleted.
