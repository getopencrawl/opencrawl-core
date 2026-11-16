# Application state consolidation

This inventory records the state owned by the core runtime before the PostgreSQL
application-state migration. Object storage remains the source of immutable
captures, attachments, memory snapshots, connector records and source API pages.
Mutable application records and durable processing bookkeeping belong in
PostgreSQL; Temporal owns execution and recovery of durable workflows.

`P` denotes the configured capture prefix (normally `sessions/self-hosted/v1`),
`H` denotes SHA-256, and `R` denotes an authorized connector raw prefix.

| Migration unit | Previous location | Owning implementation |
| --- | --- | --- |
| Local identity, memberships, invitations, sessions, password hashes, signing keys, OAuth clients/tokens/consents/device grants, rate limits and revocation epochs | `identity.sqlite`, including Better Auth plugin tables and three OpenCrawl tables | `src/identity/better-auth.mts` |
| Integrations and provisioning/disconnect intents | `integrations.sqlite` | `src/integrations/local-registry.mts` |
| Board messages, participants, subscriptions, deliveries, receipts and publication deduplication | `P/board/tenants/H(tenant).json` | `src/board/board.mts`, `participation.mts` |
| Session and memory visibility, deletion tombstones and deletion completion | `P/tenants/H(tenant)/users/H(owner)/controls/{sessions,memories}/harness/H(resource).json` | `src/sessions/controls.mts` |
| Session deletion requests | `P/_deletions/v1/H(identity).json` | `src/sessions/deletion-requests.mts` |
| Connector irreversible write fences and unresolved writers | `control/connectors/write-barriers/v1/H(scope).json` | `src/connectors/write-barrier.mts` |
| Session irreversible write fences and unresolved writers | `P/tenants/H(tenant)/users/H(owner)/controls/write-barriers/H(scope).json` | `src/sessions/write-barrier.mts` |
| Upload credential hashes and owner revocation generations | `P/_credentials/H(token).json`, `P/_credential-generations/tenants/H(tenant)/users/H(owner).json` | `src/sessions/credentials.mts` |
| Organization role-change guards | `P/organization-role-writes/organization.json` | `src/identity/role-write.mts` |
| Replicas organization approvals, installations, setup challenges and lookup indexes | `P/identity/replicas-v1/{organizations,tenants,setup}/...` | `src/identity/replicas-connections.mts` |
| Onboarding milestones | `P/tenants/H(tenant)/users/H(owner)/onboarding/{cli,mcp,mcpTest,session,history,completed}.json` | `src/onboarding-status.mts` |
| Encrypted connector grants | `connector-credentials/v1/organization/grant.enc` | `src/integrations/credential-vault.mts` |
| Encrypted operator connector configuration | `connector-settings/v1/organization/settings.enc` | `src/integrations/connector-settings.mts` |
| Session and memory indexing receipts | `P/_index/H(search)/H(job-and-scope)/batches/H(object).json` | `src/sessions/indexer.mts` |
| Connector object and snapshot indexing receipts | `derived/indexing/pipeline/H(binding-and-search)/{H(object),snapshot-fingerprint}.json` | `src/connectors/pipeline.mts`, `workspace-pipeline.mts`, `scope.mts` |
| Session indexing catch-up completion | `P/_index/temporal-cutover/H(source-and-generation).json` | `src/sessions/temporal/{handoff,client,worker}.mts` |
| Slack channel/file catalog, capture run/cursor/pacing state | `R/capture/{files-v1,messages-v1}/catalog.json`; `R/capture/{files-v1,messages-v1,message-references-v1}/run/state.json` | `src/connectors/slack-source-*.mts` |
| Distinct connector counts, processed objects and distinct record identities | `_opencrawl/counts/connection=integration.json.gz` | `src/integrations/counts.mts` |
| Materialized value reports | `P/value/tenants/H(tenant).json` | `src/application/value-report.mts`; producer belongs to the consuming runtime |

Existing PostgreSQL event identity tables retain their namespace, database UUID,
reservations, deletion records and uniqueness. Failed-upload reservations are
part of the authoritative history even when no corresponding raw batch exists.

## Data model requirements

Use explicit resource scope and typed tables. A generic key/blob relocation does
not resolve the board, count or checkpoint growth problems. Board messages,
participants and deliveries require separate rows; write fences and individual
writers require separate rows; count keys and processed objects require rows;
capture runs need bounded per-channel/thread/file progress. Bounded provider
configuration, versioned report payloads and encryption envelopes can use JSONB
or bytea alongside explicit identity and revision columns.

Core must receive raw object storage separately from application repositories.
A missing PostgreSQL configuration or incomplete migration must fail closed;
ordinary application operations must not fall back to old object state.

## Invariants that migration must preserve

- Existing identity IDs, password hashes, JWKS/signing material, sessions,
  OAuth clients/grants/device codes, consents and account epochs remain valid.
  Import every table declared by the pinned Better Auth configuration, not only
  users and memberships. Preserve the installation organization binding.
- Many resource-control keys contain only hashes, without original names in
  their values. Preserve these exact hashed identities. Never drop a control
  because an unhashed user, session or memory path cannot be recovered.
- Private/deleted resources cannot become visible during import or reindex.
  Permanent tombstones and closed write fences must remain authoritative.
- A transport failure does not prove an external write stopped. Unresolved
  writer rows and held role-operation guards never expire automatically.
  PostgreSQL advisory locks alone cannot replace these durable records.
- Connector grant/settings ciphertext authenticates its original logical path.
  Preserve that encryption context or decrypt and reseal explicitly without
  exposing plaintext in logs, command arguments or migration evidence.
- Board message IDs/order, publication retry identity, participant identity,
  subscriptions, cursors and pending delivery receipts remain unchanged.
- Replicas provider organizations cannot move between tenants, revoked
  approvals cannot reactivate, and one-time challenges retain their claim.
- Capture run/cutoff/input identity, pagination-cycle protection and next-request
  pacing survive restart. Catalog history needed to discover access revocation
  cannot be discarded as a cache.
- PostgreSQL commit and Temporal submission require a durable outbox with stable
  workflow/command identity. A process crash between them must be recoverable.
- Scope includes installation namespace, tenant, owner, resource kind and
  generation where applicable. Client-supplied identifiers do not authorize it.

## Upgrade and verification requirements

Quiesce old receivers/workers, preserve a matched recovery point, inventory
recognized namespaces, validate source bindings, import transactionally with
resumable receipts, verify exact counts/content fingerprints, then publish the
new application-state readiness binding. Source hashes/versions and completed
migration units belong in the journal. Repeated imports must compare rather than
overwrite newer PostgreSQL state. Unexpected source tables or records require an
explicit error, not silent omission. Keep logs limited to identifiers, counts,
hashes and outcomes.

Exercise a real previous release installation, including existing login and
refresh grants, pending invitations, private/deleted content, board pending
receipts, failed-upload identity reservations, connector setup/recovery and
restart. Verify both successful migration and interrupted/repeated migration.
Test matched backup restore before declaring rollback supported. Coordinate the
hosted value-report producer and every exported repository consumer with the
core release.

## Appropriate non-PostgreSQL artifacts

Immutable capture/attachment/memory/source objects remain in object storage.
Search documents remain rebuildable OpenSearch or SQLite FTS projections.
Workflow bundles and readiness files are ephemeral process output. Offline
legacy SQLite readers exist only for migration; test object-store adapters are
not supported runtime fallback paths. Recovery archives remain immutable
artifacts, with their mutable orchestration tracked by the migration system.
