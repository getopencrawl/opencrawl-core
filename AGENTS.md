# OpenCrawl core architecture instructions

Read `ARCHITECTURE.md` before changing product behavior, identity, storage, jobs,
APIs, CLI, UI, dependencies, or deployment. These rules apply throughout core.

- This repository owns the product and its usable single-tenant self-hosted
  distribution: operations, formats, resource authorization, UI, CLI, contracts,
  reference adapters, and startup tools.
- The separate proprietary hosted shell owns hosted tenant selection,
  provisioning/routing, billing, entitlements,
  managed infrastructure, fleet operations and compliance exports.
- Dependencies point into core. Never import the shell or require an OpenCrawl hosted account, license server,
  or hosted control plane to use core. Self-host uses Better Auth with one local organization; cloud continues on
  WorkOS. Keep provider verification in explicit identity adapters.
  Keep provider objects and managed credentials out of domain contracts.
- Reusable authentication and team operations belong here; hosted tenant selection
  belongs to shell. Core enforces
  resource access within an explicit trusted scope. Single tenant does not mean
  unauthenticated; no implicit default scope for hosted calls.
- Keep self-host HTTP/auth, storage, backup/restore and startup
  usable without the shell. Optional user-operated integrations belong outside
  domain logic. Do not classify all auth, HTTP, AWS or deployment code as
  proprietary merely because the hosted adapter uses them.
- Split mixed features: reusable operation and contract here, hosted adapter
  there. Implement the smallest required contract with a working single-tenant
  adapter. Do not build speculative frameworks or duplicate product logic.
- `src/` is the package product runtime; `web/` contains shared product assets;
  `cli/` is a separately released portable client; `deploy/` provides the
  supported single-tenant stack. Keep disconnected prototype tools out of the repository.
- CLI distribution is native-first: Bun bundles the application and runtime into
  an executable. Recommend the native installer in human and agent setup guidance;
  npm remains an installation alternative, with Node used only at install time.
  Keep commands, capture/startup hooks, version selection and updates Node-free.
  Preserve the legacy launcher bridge and existing credentials, owners, queues and
  cursors during migration. Keep the npm archive compatible with published legacy
  updater allowlists, and migrate only verified owned command shims automatically.
  Verify upgrades from a real published old executable, packaged installs and hooks on
  macOS, Linux and Windows, including execution without Node on PATH.
- Run `npm test` for core changes; for CLI changes also follow `cli/package.json`
  and its CI checks. Keep dependencies deliberate and review the import graph.
  The source guard is a regression aid, not a sandbox or isolation proof.
- Add fail-closed resource/scope tests with the first data-bearing operation.
  Prove a single-tenant path without hosted credentials for each product feature.
- Core and CLI are Apache-2.0; `plugins/` remains MIT. See
  `docs/PLUGIN-RELEASE.md`. Package and CLI releases are distinct artifacts.
- Describe placement and validation in each PR. Core runtime releases must be
  tested/published before the shell updates its package, lockfile and Git pin.

For a boundary change, update this contract and the hosted repository's agent
instructions together. Core contributors must not need the private shell merely
to understand, build, test or operate the open distribution.

## Organization search realms

All searchable corpora use the core organization realm: one tenant/environment
namespace, common document envelope, shared mapping and transport. Keep
source-specific metadata and resource visibility checks inside that contract.
Implementations satisfy the core-owned SearchRealm contract and the shared
adapter conformance suite. Agent API compatibility does not promise matching or
ranking parity. Keep engine-specific scripts inside adapters; product indexing
uses named write policies and field patches. SQLite FTS5 is opt-in for smaller
single-host deployments; cloud continues using OpenSearch.
Do not introduce per-feature index routing.

## React web console

`web-v2/` owns the current TypeScript React console, shared design primitives,
router, and preserved onboarding. Read `web-v2/AGENTS.md` before frontend changes.
New pages use AppShell and the shared route registry; do not fork workspace
navigation, form controls, icons, tokens, or CSS. Browser UI belongs in web-v2;
do not retain parallel HTML renderers or superseded browser scripts.
Run its strict typecheck, architecture tests, build, and browser regression suite
alongside core checks. The hosted shell consumes the published source exports;
its commercial and hosted tenancy extensions must reuse the same design system.

## Backend TypeScript

Backend source under `src/` uses strict TypeScript (`.mts`, or `.cts` for Temporal workflow bundles). Run `npm run build` before invoking compiled entrypoints under `dist/src/`; `npm test` builds first. Keep runtime import extensions `.mjs`/`.cjs`, preserve public package export names, and ship declarations with the compiled package. Do not weaken strict checks or add type-check suppression directives.

## Query and network efficiency

- Review the full operation, including adapters, pagination and retries. For a
  performance fix, first reproduce excess requests, returned rows/bytes or serial
  waits through the real module; retain an executable before/after budget test.
  Mock request counts are not production latency measurements.
- Prefer scoped bulk reads and server-side aggregates over a query per result or
  connection. Return only the fields/rows consumed. Bound batch sizes and concurrent
  work; preserve ordering, empty results, completeness checks and adapter parity.
- Share only equivalent reads. Include trusted scope and all result-changing
  arguments in keys; bound cache size/lifetime, clear rejected promises and prevent
  stale completions from repopulating invalidated state. Serialize overlapping
  background passes without losing later work or independent writes.
- Optimization must preserve fresh per-resource checks and final authorization
  barriers. Buffer results until those checks finish; test cross-tenant collisions,
  revocation/disconnect and dependency failures. Never add a blanket auth cache.
- Coalesce credential refresh within its owning client. On a delayed 401, compare
  the rejected token with the current token before refreshing again; retain a
  bounded retry limit and test staggered failures, not just simultaneous ones.

## Shared application seam

Identity adapters, core/shell ownership and the PostgreSQL state baseline are
defined once in `ARCHITECTURE.md` under "Shared application seam"; follow it.
New state belongs in PostgreSQL. Do not reintroduce a second runtime core
version. Temporal runs session indexing/deletion and connector indexing;
preserve current authorization and idempotency behavior.

Optional operator-owned connector OAuth, including Composio, belongs in core
adapters. Core must work without our managed broker account. Keep unconfigured
connectors visible with setup guidance; normal dev startup preserves onboarding.

The standalone Airbyte GitHub source under `connectors/github/` is a Python container moved from shell; preserve its source and behavior tests. This is the only Python exception. Application runtime and repository tooling remain TypeScript/Node.

## Browser rendering

Every browser screen uses client-rendered React and shared core controls. Never
compose feature markup on the server or return an alternate server-rendered UI.
`ARCHITECTURE.md` ("React document seam") defines what servers retain, the
core/shell split, and the admin-membership rule for shared integration changes.
