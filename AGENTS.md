# OpenCrawl core architecture instructions

Read `ARCHITECTURE.md` before changing product behavior, identity, storage, jobs,
APIs, CLI, UI, dependencies, or deployment. These rules apply throughout core.

- This repository owns the product and its usable single-tenant self-hosted
  distribution: operations, formats, resource authorization, UI, CLI, contracts,
  reference adapters, and startup/upgrade tools.
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
- Keep self-host HTTP/auth, storage, migrations, backup/restore and startup
  usable without the shell. Optional user-operated integrations belong outside
  domain logic. Do not classify all auth, HTTP, AWS or deployment code as
  proprietary merely because the hosted adapter uses them.
- Split mixed features: reusable operation and contract here, hosted adapter
  there. Implement the smallest required contract with a working single-tenant
  adapter. Do not build speculative frameworks or duplicate product logic.
- `src/` is the package product runtime; `web/` contains shared product assets;
  `cli/` is a separately released portable client; `deploy/` provides the
  supported single-tenant stack. Keep disconnected prototype tools out of the repository.
- Run `npm test` for core changes; for CLI changes also follow `cli/package.json`
  and its CI checks. Keep dependencies deliberate and review the import graph.
  The source guard is a regression aid, not a sandbox or isolation proof.
- Add fail-closed resource/scope tests with the first data-bearing operation.
  Prove a single-tenant path without hosted credentials for each product feature.
- Core and CLI are Apache-2.0; `plugins/` remains MIT. Keep repository visibility
  private until an explicit publication instruction; see
  `docs/PLUGIN-RELEASE.md`. Do not promise self-host readiness from the greeting smoke
  runner. Package and CLI releases are distinct artifacts.
- Describe placement and validation in each PR. Core runtime releases must be
  tested/published before the shell updates its package, lockfile and Git pin.

For a boundary change, update this contract and the hosted repository's agent
instructions together. Core contributors must not need the private shell merely
to understand, build, test or operate the open distribution.

## Organization search realms

All searchable corpora use the core organization realm: one tenant/environment
namespace, common document envelope, shared mapping and transport. Keep
source-specific metadata and resource visibility checks inside that contract.
Do not introduce per-feature index routing. Existing data requires verified
migration and rollback coverage before switching runtime reads or writes.

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

## Shared application seam

The single-tenant product uses Better Auth with local accounts in an operator-owned
SQLite database. Cloud continues to use WorkOS. Both adapters expose core-owned
identity directory facts; provider sessions and tokens stay at their runtime boundary.
Reusable authentication, membership, role controls, UI, Airbyte and connector
lifecycle implementations belong in core. Hosted multi-tenant selection and
provisioning, billing, fleet operation and internal administration belong in
shell. Source SDK names do not determine ownership. Core requires no account
or service operated by OpenCrawl. This contract supersedes earlier hosted-only
classification of reusable identity, integrations and product UI.

The standalone Airbyte GitHub source under `connectors/github/` is a Python container moved from shell; preserve its source and behavior tests. This is the only Python exception. Application runtime and repository tooling remain TypeScript/Node.

## Browser rendering

Every browser screen uses client-rendered React and shared core controls, including
organization setup, auth outcomes, provider handoffs, capture setup and legal pages.
Servers send an empty application mount plus escaped inert page data; never compose
feature markup or return an alternate server-rendered UI. Authorization, cookies,
HTTP status and identity-changing redirects remain server responsibilities.
