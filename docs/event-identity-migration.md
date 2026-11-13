# PostgreSQL event identity upgrade

Capture batches and attachments remain in S3-compatible storage. PostgreSQL now
stores one fingerprint row per immutable event. There is no per-session byte or
event-count ceiling in this adapter. A batch reserves all its IDs transactionally:
same ID and content is an idempotent retry; same ID and different content rejects
the whole batch. A failed raw upload retains its reservation.

The supported application, capture-only receiver and workers require
`OPENCRAWL_DATABASE_URL`. The Compose distributions provide an operator-owned
PostgreSQL database on their private network. External deployments can supply a
normal PostgreSQL URL with verified TLS, using an application database rather
than Temporal's internal database. The role must own the identity tables and
be able to create them on first startup. `OPENCRAWL_EVENT_IDENTITY_NAMESPACE`
defaults to the S3 bucket name; keep it stable across credential/endpoint changes,
and unique when independent object stores share one database. Prefix, tenant,
user, harness, installation and session remain part of every reservation's scope.

## Existing Compose installations

Keep the previous source revision and its backup receipt. After checking out the
upgrade, run:

```sh
node deploy/upgrade.mjs /absolute/path/to/new-pre-upgrade-backup
```

The command builds before downtime, adds only the new database credential to
the existing private `.env`, stops the stack, creates and hashes a cold backup,
starts storage, migrates all sessions, then starts the application and workers.
It preserves existing credentials and named volumes. A failure after stopping
writers leaves them stopped. Resolve the reported storage/database access or
conflicting historical IDs before restarting; do not delete the source or reset
volumes. Resume the migration with:

```sh
cd deploy
docker compose up -d --wait app-db s3
docker compose run --rm --no-deps app node dist/src/sessions/identity-migration.mjs migrate
docker compose up -d --wait
```

For `compose.capture.yaml`, use `receiver` in place of `app` and the same Compose
file selection used by that installation. For separately operated services,
stop all receivers/workers, back up both stores, supply their normal storage and
database environment, run the same compiled migration entrypoint, then start
the new receivers and workers. No hosted control-plane access is involved.

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

An ordinary `up.sh` restart also migrates individual sessions lazily before their
first new reservation. The offline command is the recommended upgrade for large
installations and is required when upgrading writers from before immutable event
ledgers were introduced. Deploy the receiver and index worker together. A migrated
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
