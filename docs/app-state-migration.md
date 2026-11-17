# Scoped PostgreSQL upgrade

The current runtime reconciles product behavior to the verified hosted baseline.
PostgreSQL remains authoritative for Better Auth, the integration registry, board
history/delivery and capture event identities. Other state retains its established
object-store representation. Raw captures, attachments and connector dumps remain
in object storage. No whole-application migration or connector lifecycle rewrite
is required for subsequent feature releases.

## Existing installations

Use `./deploy/up.sh` or `./dev/up`. The upgrader preserves the previous image and a
matched cold backup, stops writers, imports SQLite auth/registry and the single
organization's board, verifies the copy, then starts the new runtime. It preserves
passwords, signing keys, sessions, refresh grants, memberships and board receipts.
`OPENCRAWL_IDENTITY_PATH` and `OPENCRAWL_REGISTRY_PATH` are legacy import inputs;
runtime auth and registry never fall back to those files.

The scoped importer checks exact organization, bucket, prefix and database namespace.
It imports only auth, registry and board. Existing privacy/deletion controls,
credentials, onboarding receipts and indexing progress retain their original
representation. An incomplete import refuses changed source data. A completed
receipt prevents a later upgrade from replaying stale source files over new SQL
writes. Retained source files and matched backups are recovery data, not runtime
fallbacks; do not delete them as incidental cleanup.

For separately operated infrastructure, stop every writer and preserve a matched
backup before running these commands with the installation's own environment:

```sh
node dist/src/state/migrate.mjs check --writers-stopped --expect-existing
node dist/src/state/migrate.mjs migrate --writers-stopped --expect-existing
node dist/src/state/migrate.mjs verify --writers-stopped --expect-existing
```

Fresh Compose and Helm installations initialize the three stores before starting
writers. A Helm rollback alone cannot reverse a storage cutover. Recover the old
runtime together with its matched data and configuration using `deploy/restore.mjs`.

## Already used the retired whole-application migration

Do not point this runtime at a completed or partial whole-application migration.
Startup rejects that installation rather than reading stale object-store controls.
Retain the existing runtime, or restore its verified pre-migration recovery point
and then perform the scoped upgrade. Schema version 2 from the retired online
migration also requires that recovery path. No automatic reverse migration is
provided.

Hosted production already uses separately admitted PostgreSQL board and registry
repositories. Its normal core upgrade retains those namespaces and receipts and
runs no historical import.
