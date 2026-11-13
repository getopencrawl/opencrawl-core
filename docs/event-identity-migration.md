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

For separately operated services, stop all receivers/workers, back up raw objects
and the application database together, supply their normal storage and database
environment, and run `node dist/src/sessions/identity-migration.mjs migrate`
before starting the new receivers and workers. No hosted control plane is needed.

## Migration and interruption behavior

The migration includes every legacy ledger, including those left by failed
uploads with no corresponding raw batch. A valid version-1 ledger already
contains the historical bootstrap and every later reservation; it is imported
directly without re-reading every upload. Sources without a ledger are rebuilt
from retained raw batches, including pre-ledger installations. Imports commit in small transactions and
record each session's progress in PostgreSQL. Re-running scans is safe; completed
sessions are skipped. Inventory is paginated and historical batches are read
one at a time. There is no total inventory/session/event quota.

Before accepting new IDs, the adapter replaces the old ledger using its object
version with a small version-2 marker identifying the PostgreSQL database.
Concurrent version-1 writers must win that compare-and-set first or fail after
the marker appears. If one wins, its additional reservations are imported before
retrying the fence. All imported fingerprints commit before the marker is written;
a crash before or after the fence resumes safely. The marker contains no event
map and never grows with the session. Old software cannot overwrite it.

Startup scripts coordinate the upgrade before replacing old writers or
changing the installation configuration. After upgrading, individual sessions can also migrate lazily
before their first new reservation. Separately operated services must stop old
writers before switching, especially versions from before immutable event ledgers.
Deploy the receiver and index worker together. A migrated
source presented to a different/empty database fails closed, rather than silently
falling back to an old ledger. Resolve an actual content conflict explicitly; do
not pick an arbitrary winner or remove a failed-upload reservation.

## Backup, deletion and rollback

Cold Compose backups include the application database volume alongside raw
storage, search, identity and Temporal state. External deployments must quiesce
all writers and back up raw storage and PostgreSQL as one recovery point. Restore
them together, including the database identity and migration state. A PostgreSQL
snapshot older than the raw storage may omit reserved IDs; never combine them.
Permanent session deletion removes fingerprint rows from all installations and
retains a scoped deletion marker to reject late writes.

After cutover, rolling back to a binary that writes JSON ledgers is not supported:
it deliberately rejects the migration marker, and cannot represent sessions that
have grown beyond its old ceiling. Roll back application code only to a version
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
