# PostgreSQL event identity upgrade

Capture batches and attachments remain in S3-compatible storage. PostgreSQL now
stores one fingerprint row per immutable event. There is no per-session byte or
event-count ceiling in this adapter. A batch reserves all its IDs transactionally:
same ID and content is an idempotent retry; same ID and different content rejects
the whole batch. A failed raw upload retains its reservation.

The supported application and workers require
`OPENCRAWL_DATABASE_URL`. The full Compose application provisions a separate logical application
database on its existing PostgreSQL server, on the private network. External deployments can supply a
normal PostgreSQL URL with verified TLS, using an application database rather
than Temporal's internal database. The role must own the identity tables and
be able to create them on first startup. `OPENCRAWL_EVENT_IDENTITY_NAMESPACE`
defaults to the S3 bucket name; keep it stable across credential/endpoint changes,
and unique when independent object stores share one database. Prefix, tenant,
user, harness, installation and session remain part of every reservation's scope.

## Existing Compose installations

Use the [coordinated full-application upgrade](upgrades.md). It builds before
downtime, backs up the old runtime and matched stores, provisions the logical
application database, migrates event identities, and verifies service health.
Both `./deploy/up.sh` and `./dev/up` invoke it for existing installations. A retry
resumes its journal and retains the original recovery point. Installations that
already created a dedicated `app-db` are copied transactionally with their exact
database UUID, reservations and deletion records, then that old server stops.

For separately operated services, follow the complete
[application-state migration](app-state-migration.md), including stopped writers,
a matched recovery point, import and independent verification before restarting.
The event-identity importer is one component of that migration; running
`node dist/src/sessions/identity-migration.mjs migrate` alone does not establish
application readiness or authorize receiver/worker startup. No hosted control
plane is needed.

## Migration and interruption behavior

The migration includes every legacy ledger, including those left by failed
uploads with no corresponding raw batch. A valid version-1 ledger already
contains the historical bootstrap and every later reservation; it is imported
directly without re-reading every upload. Sources without a ledger are rebuilt
from retained raw batches, including pre-ledger installations. Imports commit in small transactions and
record each session's progress in PostgreSQL. Re-running scans is safe; completed
sessions are skipped. Inventory is paginated and historical batches are read
one at a time. There is no total inventory/session/event quota.

The offline importer never rewrites raw objects or legacy ledgers. It re-reads
the ledger before marking a session ready, and fails if an old writer changes
that source during import. Imported fingerprints remain durable for a safe retry.
Existing version-2 markers from older PostgreSQL releases still require their
matching database UUID, namespace and reservation rows; restore that matched
database if they are absent.

Runtime reservation uses PostgreSQL only. There is no object-store fallback,
lazy historical bootstrap or marker write. Application readiness requires the
whole-source offline import and verification before starting any new receiver
or worker. A session whose import is incomplete rejects new reservations.
Resolve content conflicts explicitly; never choose an arbitrary winner or remove
a failed-upload reservation. The legacy audit command is read-only and requires
an explicit organization and user; its old `--initialize` action is retired.

## Backup, deletion and rollback

Cold Compose backups include the application database volume alongside raw
storage, search, identity and Temporal state. External deployments must quiesce
all writers and back up raw storage and PostgreSQL as one recovery point. Restore
them together, including the database identity and migration state. A PostgreSQL
snapshot older than the raw storage may omit reserved IDs; never combine them.
Permanent session deletion removes fingerprint rows from all installations and
retains a scoped deletion marker to reject late writes.

After cutover, rolling back to a binary that writes JSON ledgers is not supported:
its old ledgers no longer receive new reservations and cannot represent sessions
that have grown beyond its old ceiling. Roll back application code only to a version
that understands the PostgreSQL adapter, keeping the database. If restoring a
pre-upgrade recovery point is necessary, stop every writer and restore its entire
matched backup; account for any data accepted after that backup first. Never
convert a large PostgreSQL session back to a truncated JSON ledger.

## Bulk request sizing

Search batching has a scheduling target, not a document-size admission rule.
Larger documents are sent alone. A whole-request provider HTTP 413 splits a batch
by document boundaries and learns a smaller target for that realm. Only a real
provider rejection of an individual document is marked permanent. Partial item
failures and ambiguous network failures retain their normal retry semantics and
cannot claim that earlier writes were not applied. Scope validation covers the
entire call before any request is sent.

`bulkTargetBytes` configures the target for an OpenSearch adapter. The initial
target starts at the provider's documented 3 MiB recommendation. The reproducible
`tools/benchmark-bulk.mts` compares 1, 3, 8 and 16 MiB on a disposable loopback
OpenSearch, records throughput, request latency, wire bytes and process memory,
and verifies an individual document larger than 4 MiB by reading it back. Results
must be considered with the tested hardware/workload; they do not establish a
universal capacity limit. No target is an acceptance ceiling.
