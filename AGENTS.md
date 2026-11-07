# OpenCrawl core architecture instructions

Read `ARCHITECTURE.md` before changing product behavior, identity, storage, jobs,
APIs, CLI, UI, dependencies, or deployment. These rules apply throughout core.

- This repository owns the product and its usable single-tenant self-hosted
  distribution: operations, formats, resource authorization, UI, CLI, contracts,
  reference adapters, and startup/upgrade tools.
- The separate proprietary hosted shell owns WorkOS, hosted organizations and
  membership resolution, tenant provisioning/routing, billing, entitlements,
  managed infrastructure, fleet operations and compliance exports.
- Dependencies point into core. Never import the shell or require WorkOS, an
  OpenCrawl hosted account, license server, or hosted control plane to use core.
  Keep provider objects and managed credentials out of domain contracts.
- Authentication/tenant selection belong to runtime adapters. Core enforces
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
  `cli/` is a separately released portable client; `integrations/` contains
  optional customer-operated adapters/tooling and is not in the core package.
- Run `npm test` for core changes; for CLI changes also follow `cli/package.json`
  and its CI checks. Keep dependencies deliberate and review the import graph.
  The source guard is a regression aid, not a sandbox or isolation proof.
- Add fail-closed resource/scope tests with the first data-bearing operation.
  Prove a single-tenant path without hosted credentials for each product feature.
- Core is public under Apache-2.0; `plugins/` is MIT and exported separately (see
  `docs/PLUGIN-RELEASE.md`). Keep README capability claims to what a self-hoster
  can run today with `deploy/` and the documented steps. Package, CLI and optional
  integration releases are distinct artifacts.
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
