# PostgreSQL application-state migration

This upgrade moves mutable application records from SQLite and S3-compatible
objects into the installation's PostgreSQL application database. Raw capture
batches, attachments and immutable connector source documents remain in object
storage. The selected search index remains a derived index; this upgrade does
not change search engines. Temporal retains its own databases and workflow
history.

## Supported baseline and acceptance

The current stable baseline is `v0.4.1`, commit
`fc748cbcba9da2c9830d842b38a2fcc19c340bd7`, published on November 15, 2026.
The release acceptance must boot that unchanged version, create retained state,
run the ordinary upgrade command, exercise interruption/resume, restart, a
subsequent upgrade and matched old-version restoration. A newly created database
or a mocked import alone does not establish upgrade compatibility.

The migration acceptance covers both supported startup paths (`deploy/up.sh`
and `dev/up`) and both search choices. The retained-Airbyte upgrade check is
required for the release because connector lifecycle execution changes.

## Operator procedure

Keep the original checkout, private configuration, organization ID, hostname,
Docker project, volumes and encryption secrets. Update that checkout to the
tested release and inspect its plan:

```sh
./deploy/upgrade.sh --installation deploy --check
./deploy/upgrade.sh --installation deploy --backup /private/new-recovery-directory
```

For an installation created with `dev/up`, use `--installation dev`. Running the
installation's normal startup command invokes the same coordinated upgrade.
Keep the previous startup options; selecting a different search engine requires
a separate migration.

The upgrader preserves immutable old images before building replacements,
drains application and worker processes, pauses its owned development Airbyte
node, and creates a checksummed matched recovery point before any data change.
External Airbyte operators must pause affected connections and let active jobs
finish. Do not run an old application process during migration.

Inventory every writer, including historical reindex/migration jobs, separately
scheduled activities, administrative commands and workers running old images.
Changing the API's package pin or stopping new job admission does not retire
already running jobs. Confirm those exact executions have completed or drained
before state cutover; an unconfirmed writer blocks migration. Hosted deployment
automation must enforce the same requirement before it advances a dependent
runtime release.

The upgrade then provisions the application database, imports older event
identity storage when necessary, checks and migrates application state, verifies
the completed import, and only then starts the new API and worker. JSON progress
records identify the phase and recovery directory without printing credentials.

Rerun the same command after a failure. It resumes its recorded target and keeps
the original complete recovery point. Do not edit or remove an upgrade journal,
restart old binaries against partly migrated stores, or change the target while
an upgrade is incomplete.

## Migration contract

The state migration command is included in the runtime image:

```sh
node dist/src/state/migrate.mjs check --expect-existing
node dist/src/state/migrate.mjs migrate --writers-stopped --expect-existing
node dist/src/state/migrate.mjs verify --writers-stopped --expect-existing
```

It uses the installation's normal private environment and the original SQLite
paths. A separately operated deployment must stop every API, worker and other
writer and create a matched backup of PostgreSQL, SQLite, source objects,
configuration and Temporal before invoking it. The Compose upgrader rejects
external database layouts and custom storage overlays rather than guessing how
to back them up. The standalone commands do not create that operator-managed
backup.
`--writers-stopped` records an operator assertion for an existing installation;
it does not stop processes itself. `--expect-existing` prevents a wrong mount or
missing previous installation from being treated as a new empty installation.
The coordinated upgrader supplies both flags. Omit them for a provably empty new
installation. Already-ready installations validate their binding and receipts
without requiring retained legacy files to remain forever.
The supported single-organization installation uses one landing bucket. A legacy
integration pointing at another bucket stops migration before any import; its
state requires an explicitly reviewed multi-store inventory, not an assumed
empty checkpoint.

`check` inventories and validates without changing application data. `migrate`
uses a database migration lock and resumable progress. `verify` must reject
incomplete imports, mismatched installation bindings or divergent data. New
runtime readiness requires the completed database binding. A database outage
must never cause a fallback to legacy SQLite or object-store app state.

The importer preserves account and resource IDs, password hashes, signing keys,
browser sessions, OAuth clients/grants/consents, invitation and consumed-bootstrap
state, revocation epochs, connector credentials and original encryption
context. It also preserves application records such as board publication and
delivery state, privacy/deletion controls, onboarding, installation bindings and
pending lifecycle work. Raw source object bytes remain unchanged.

Retained legacy data is recovery material after cutover, not a second writable
database. Subsequent starts and upgrades must not recopy stale legacy state over
new PostgreSQL writes. Cleanup of retained source files/objects requires a
verified recovery point and an explicit retirement procedure; this upgrade does
not delete them automatically.

## Recovery and verification

Use the [matched recovery procedure](upgrades.md#restore-a-matched-recovery-point).
Restore the exact old runtime images and all matched stores together into empty
owned volumes. Preserve writes accepted after the backup separately before
choosing to restore. A binary-only rollback is not supported after state
cutover, and old binaries do not understand the new database migration fence.

Before reopening access, verify existing password and browser sign-in, an old
CLI/MCP grant, revoked-grant denial, membership permissions, private-resource
visibility, retained session search, board history/delivery and connector access.
Check one fresh capture and connector sync after upgrading, and check them again
after a restore rehearsal. Keep original and restored stacks from sharing active
Airbyte connections.

Release evidence must include the exact old/new revisions, redacted per-domain
verification results, failure/resume result, restart result and recovery-manifest
checksum. Synthetic fixture credentials belong in private test scratch and must
not enter uploaded acceptance receipts.

### Retiring pre-Temporal session scheduler state

The reviewed historical producer is core `c05067b` (first implementation) through
`154fec0^` (last version before scheduled Temporal workers). Its indexer did not
change over that interval. Migration recognizes only these exact formats:

- `<prefix>/index-pending/tenants/<tenant-hash>/users/<user-hash>/<source-key-hash>.json`: `{sourceKey}`.
- `<prefix>/_index/<search-hash>/<job-and-owner-hash>/batches/<source-key-hash>.json`: failed retry evidence with `status`, `sourceKey`, positive `attempts`, `lastAttempt`, `nextAttempt`, and the fixed error `INDEXING_FAILED`. Successful `indexed` receipts retain their existing importer.
- The same index scope's `cursor.json`: `{nextToken,updatedAt}`; `reconcile.json`: `{nextToken}`. A token is an opaque string or null.

These instructions become normalized PostgreSQL scheduler-retirement evidence,
separate from successful indexing receipts. Original objects and their exact
source hashes remain retained. A pending or failed instruction must match its
owner scope and source-key hash; a missing raw source blocks migration unless a
matching authoritative deletion tombstone proves that the session was deleted.
Malformed or unknown scheduler objects still block migration.

Old list cursors cannot safely transfer to a new scheduler. The PostgreSQL state
release adds `postgres-app-state-v1` to `sessionIndexingGeneration`, forcing a new
Temporal catch-up workflow and completion-marker identity for the same trusted
search/job configuration. That workflow scans the raw source from the beginning;
existing successful batch receipts still avoid duplicate indexing. Imported old
cutover markers cannot complete the new generation. Operators must drain old
workers before migration, then run and await the supported activation/catch-up
before considering search caught up. Database migration readiness alone does not
claim that the asynchronous search catch-up has completed.

The published-version upgrade fixture stops the old worker before seeding its
half-done operations and keeps it stopped through the source snapshot. The old
API still runs during the read-only upgrade check. Exact source hashes are
checked again after the upgrader stops writers, before any migration, and after
import. Matched restore verifies the old bytes and typed readbacks before
restarting the old worker; normal live acceptance then runs with workers active.
This ordering prevents a legitimate old deletion retry from changing the test
snapshot before migration and does not weaken source-preservation checks.

Actual Docker upgrade evidence is indexed in
[app-state-docker-upgrade.json](evidence/app-state-docker-upgrade.json). Each result
is bound to an exact candidate revision and artifact. Earlier success does not
validate later importer changes; retained-Airbyte acceptance remains incomplete
until its complete upgrade and matched-restore gate passes.
