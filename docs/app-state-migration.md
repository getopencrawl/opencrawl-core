# PostgreSQL application-state migration

This upgrade moves mutable application records from SQLite and S3-compatible
objects into the installation's PostgreSQL application database. Raw capture
batches, attachments and immutable connector source documents remain in object
storage. The selected search index remains a derived index; this upgrade does
not change search engines. Temporal retains its own databases and workflow
history.

Core 0.5.0 removes SQLite as a self-host integration-registry backend. The registry
and its lifecycle commands require `OPENCRAWL_DATABASE_URL`; there is no fallback.
`OPENCRAWL_REGISTRY_PATH` is accepted only by the offline legacy import command,
not by runtime configuration. The existing read-only SQLite importer remains a
recovery tool for coordinated application-state upgrades; it does not preserve
support for running an installation on SQLite. Back up and migrate an existing
installation separately before starting the new runtime.

## Required board upgrade for 0.5

Existing self-hosted installations **must run `deploy/upgrade.sh` before starting
core 0.5.0 or later**. This is a maintenance upgrade: the script drains the old
writers, creates a matched recovery backup, migrates the existing object-store
board into application PostgreSQL, verifies it, and starts the new runtime only
after the complete installation has passed verification. A rolling image change
alone is not a supported migration from 0.4.1.

```sh
./deploy/upgrade.sh --installation deploy --check
./deploy/upgrade.sh --installation deploy --backup /private/new-recovery-directory
```

Use `--installation dev` for a development installation. Keep the same checkout,
organization, object bucket/prefix, secrets and Docker project. Rerun the same
command after interruption; do not initialize a new empty installation to bypass
an incomplete upgrade. Normal startup invokes this same mandatory upgrader.

The board import preserves publication IDs and bodies, authenticated authors,
retry IDs, mentions, agent registrations and subscriptions, usage counters,
acknowledgment cursors and pending delivery receipts with their original messages.
It compares the reconstructed PostgreSQL state with the retained source before
admitting the runtime. Import and replay use bounded SQL batches; ordinary
heartbeat replay retains unchanged publication and search rows. Unsupported
fields, incomplete history and conflicting target state fail the upgrade.

The old source and recovery backup remain available for matched restoration.
After the new runtime accepts writes, restore the complete matched backup to
return to the old version; never restart an old writer against the stale board
object. Self-host maintenance upgrades do not authorize a cloud outage: hosted
cutover follows its separately verified deployment procedure.

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

The same upgrade sequence applies to installations already using PostgreSQL,
including `0.4.1-cd.478.ge5cc8bc3ec70`. Run the supported upgrade or migration
command before starting the new runtime: its schema preparation adds the
byte-order indexes before checking the saved manifest. It preserves the existing
migration ID, source hashes and receipts, and does not reimport legacy objects.
The first index build belongs in this stopped-writer upgrade phase; later
readiness checks validate the existing index without rebuilding it. Keep the
original upgrade journal and backup when resuming an interrupted upgrade.

The stopped-writer upgrade also applies known legacy column, constraint and
index changes once. Current runtime readiness validates their definitions
without repeating `ALTER TABLE` or `CREATE INDEX` on installed objects. An
incompatible existing definition stops preparation for operator review; the
runtime does not replace it automatically.

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


## Unprovable historical connector caches

Old connector object/snapshot receipt paths hash the tenant, connection and search
identity, but do not retain that search identity in their payload. Migration
preserves their exact source hashes and normalized typed audit rows in
`opencrawl_connector_cache_retirements`, scoped by installation, donor bucket and
original key. They never become PostgreSQL indexing skip receipts. Object receipts
must still match exactly one original integration landing prefix in their donor.

Historical Slack `slack-v1` through `slack-v4` object receipts may omit
`sourceRecords`; those producers did not record the source count. Migration
preserves that omission as an unknown SQL `NULL` in the audit and omits the field
on exact readback. It never invents zero or grants active indexing authority.
Newer pipelines still require the count, and every receipt retains its original
source binding and full connector catch-up requirement.

`connectorCatchupRequired` reports how many historical caches require the release
catch-up gate. Import readiness proves retained application state, not connector
catch-up. Activate full scans of current authorized connector references using the
existing Temporal generation and await their actual completion before claiming
catch-up. The completion gate records separate migration/reference-bound evidence;
it never changes the immutable retirement audit or marks an old cache as current.
