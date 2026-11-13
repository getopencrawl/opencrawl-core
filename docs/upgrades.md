# Upgrade the full self-hosted application

Keep the installation's original checkout, private configuration and Docker
project. Update that checkout to the tested release you intend to install; do not
start a second clone with newly generated credentials. `./deploy/up.sh` and
`./dev/up` automatically coordinate upgrades of an existing full application.
Use the same startup options as before. Search backend changes remain a separate
migration; an upgrade does not switch an existing index.

An operator's agent can inspect and run the same operation directly with Node 24:

```sh
node deploy/upgrade.mjs --installation deploy --check
node deploy/upgrade.mjs --installation deploy --backup /private/new-recovery-directory
# For installations created with ./dev/up, use --installation dev instead.
```

`--check` is read-only. Commands emit JSON lines with the project, target revision,
phase, recovery directory and result. A failure exits nonzero. Rerun the same
command after fixing the reported failure; the journal resumes completed work
and never replaces its original completed backup. If a different release is
checked out while an upgrade is incomplete, return to the recorded target first.
Normal startup also resumes the journal.

The operation builds the new image before downtime, pauses owned Airbyte jobs
for a development installation, stops the old application and its dependencies,
and creates a cold recovery point. It preserves organization IDs, logins, OAuth
grants, encryption keys and named volumes. The backup includes all recorded
Compose volumes, original private configuration, immutable old container images,
and checksums. Allow free disk for the compressed stores and exported images.
Backups contain credentials and user data: keep them private and retain them
until recovery is no longer needed. Default backups live under
`deploy/.upgrade/backups` or `.opencrawl-dev/backups` and are excluded from Git
and Docker build contexts.

The application uses the existing `temporal-db` PostgreSQL server through a
separate `opencrawl` database and non-superuser login. Temporal retains its own
databases and credentials. The one-shot `database-ready` service provisions the
logical database idempotently. An installation that already has a dedicated
`app-db` retains its original backup and stopped volume; its identity tables are
copied transactionally and verified row for row, including its database UUID
and deletion records. No source volume is automatically deleted.

Next, event-ledger migration scans the retained object store, using per-session
commits for restartability. The app and worker must pass their normal health
checks. For `dev/up`, its normal installer also resumes Airbyte and republishes
the app endpoint. A build failure leaves the old app running. A later failure
stops application writers; inspect a `writers-stop-unconfirmed` result before
allowing any further writes. Fix the failure and resume, rather than starting
old binaries against partly migrated storage.

## Restore a matched recovery point

A rollback to JSON-era code requires the whole pre-upgrade recovery point.
Restoring discards subsequent work if you choose to replace the live installation;
preserve that newer data separately first. This tool never deletes it for you.

```sh
node deploy/restore.mjs --backup /private/recovery-directory
```

Restore requires the original project to be stopped, empty destination volumes,
and absent or exactly matching saved configuration files. It verifies checksums,
loads the saved images, restores every store together, and emits the exact Compose
command to start those old images. Use that command, not the newer source's
Compose file. Check login, retained session search, board history and connector
retrieval before reopening access. Starting the updated checkout later runs the
upgrade again.

The separately deployed Airbyte control plane is not in the Compose recovery
archive. Its connections, grants and owned development cluster remain in place
during upgrade. Back up an external Airbyte deployment using its own procedure;
never run original and restored apps against the same connections concurrently.
Custom writable bind mounts, external Compose overlays and installations from
the removed fixed-identity distribution require an explicitly reviewed migration;
the automated upgrader refuses to guess their ownership or backup coverage.

CI starts immutable older full applications for both startup paths and both
pre-PostgreSQL and dedicated-PostgreSQL layouts. It checks existing account and
OAuth identity, search and board persistence, idempotent event retry, conflicting
event rejection, new writes, failure/resume, restart, and matched old-version
restore. Fresh full-application checks cover x64, ARM64 and the SQLite profile. The
explicit full-Airbyte workflow also upgrades an older default installation and
checks its retained connector and source-to-search path.
