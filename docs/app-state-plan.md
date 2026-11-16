# PostgreSQL application-state consolidation

Implementation branch starts at `bcfe0643abdf16a06734dd844576cb0cdb04f9cf`.
Current published upgrade baseline is core `v0.4.1`, source
`fc748cbcba9da2c9830d842b38a2fcc19c340bd7`.

## Target contract

- PostgreSQL owns mutable application state. Explicit repositories distinguish
  accounts, integrations, board rows, resource controls, credentials, durable
  operations, source checkpoints and derived measurements.
- S3-compatible storage owns immutable captured source batches, memory snapshots,
  attachments, connector source pages and retained immutable recovery archives.
- OpenSearch or optional SQLite FTS owns the rebuildable search projection.
- Temporal owns durable execution, recovery and appropriate maintenance schedules.
  Workflow histories contain scoped references, not secret or content payloads.
- An application namespace is bound to its source installation, bucket and capture
  prefix. Missing/incomplete/mismatched migration bindings block API and workers.
  Database failure never selects a legacy object-store or SQLite state backend.

## Work ownership

- Integration owner: common PostgreSQL connection/schema/binding, typed state
  repositories, raw/state port separation, board normalization, runtime wiring,
  migration import coordination, complete verification and release.
- Identity lane: Better Auth and integration registry PostgreSQL adapters, exact
  offline SQLite import, authentication continuity and registry transaction tests.
- Workflow lane: durable integration lifecycle, command/outbox contract, safe
  disconnect, maintenance/count workflows, replay and retry tests.
- Migration lane: existing deployment/recovery engine, current-release fixture,
  failure/resume and matched restore acceptance, operational documentation.
- Subsequent independent review rotates ownership after implementations stabilize.
  Helm charts and their image distribution work are maintained separately.

## Required invariants

Preserve auth IDs/password hashes/JWKS/sessions/grants, organization and owner
scope, encrypted-secret ciphertext and original AAD, hashed-only private resource
identities, permanent deletion tombstones, closed write admission and every
unresolved external writer, role guards, board message IDs and pending delivery
receipts, capture retry identities, workflow IDs and existing history compatibility.
Never infer successful external side effects or writer drain from age, cancellation,
connection loss or a missing provider listing.

Migration stops every old writer, retains verified matched backups, imports in
bounded resumable transactions, verifies source/target counts and hashes and
then enables new writers. A retry cannot overwrite new live state from stale
legacy objects. Binary-only rollback is unsupported; restore the matched recovery
point. Unknown legacy state is an error requiring classification, not ignored data.

## Acceptance gates

1. Exhaustive state inventory and all call sites assigned to explicit repositories.
2. Real PostgreSQL concurrency, isolation, transaction rollback and failure tests.
3. Full core/typecheck/UI and required adapter suites, no unexplained skips.
4. Actual v0.4.1 installation upgraded through ordinary startup: accounts,
   active/revoked credentials, private/deleted resources, pending board receipts,
   integrations, unresolved writer fences, new capture/retry/search and restart.
5. Interrupted migration resumes with original recovery point; changed source or
   divergent target fails closed; rerun never recopies stale objects.
6. Matched old-image/store restore and retained connector sync succeed. Full Airbyte
   acceptance runs on the exact release candidate.
7. Runtime object-store writes are limited to documented immutable source/archive
   classes. Legacy import readers remain only in explicit migration tooling.
8. Exact immutable core artifact precedes hosted consumer pin/lock updates. All
   old-image historical migration jobs must positively drain before control-store
   cutover; an API revision change alone does not drain those writers.
9. Live health plus authenticated behavior verified after coordinated rollout.

The inventory and migration documents contain detailed schemas, source locations
and test fixtures. This plan records acceptance criteria, not completed evidence.
