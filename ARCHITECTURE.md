# Single-tenant core and hosted shell

## Contract

OpenCrawl core must provide a useful single-tenant product on infrastructure a
customer controls, without access to the proprietary shell, WorkOS, an OpenCrawl
account, or our control plane. One tenant is one customer/security boundary;
it may eventually contain multiple users. Basic security is part of core's
self-hosted distribution, not a proprietary add-on.

The hosted shell adds managed multitenancy and operation around the same product
implementation. Both the self-host runtime and hosted shell depend on core-owned
contracts; core never depends on the shell. No hosted entitlement checks,
provider user/session objects, mandatory hosted telemetry, or `isCloud` branches
in domain logic. No duplicated hosted version of a core operation.

## Placement

| Core repository | Proprietary hosted shell |
| --- | --- |
| Capture/ingestion, parsing, indexing, retrieval, context assembly and product formats | Hosted tenant provisioning, organization membership, routing/switching and lifecycle |
| Product UI, shared assets, CLI/protocol clients | WorkOS SDK/AuthKit, provider sessions, enterprise identity integration |
| Domain validation, resource ownership/permission enforcement, deletion semantics and migrations | Identity-to-principal mapping, hosted admission, billing and entitlements |
| Storage/job/auth contracts with working single-tenant reference adapters | Tenant-scoped managed storage/jobs, fleet scheduling, quotas and isolation infrastructure |
| Self-host HTTP/API runtime, identity integration, startup, backup/restore and upgrades | Our AWS account/IAM/SSM/edge configuration, deployment/rollback and operations |
| Audit events and portable diagnostics | Compliance exports, managed monitoring and support access |
| Optional customer-operated integrations and storage adapters | Hosted vendor accounts, shared credentials and commercial service operation |

Classify by responsibility. A local HTTP server, self-host authentication adapter,
Compose/Helm example, or optional S3-compatible client can live here. Keep these
adapters out of domain logic. Selecting an AWS storage option must not require
every user to have AWS credentials. Third-party services retain their own
licenses; bundling or offering them as managed services needs separate review.

`src/` contains the package runtime, `web/` shared assets, `cli/` the independent
client, and `integrations/` optional operator tooling. The latter is not included
in the current core npm package. Add seams only alongside an implemented feature
and a working reference adapter; an interface without a usable implementation
does not deliver self-hosting.

## Trust and scope

The runtime verifies credentials and supplies a provider-neutral principal and
authorized scope. In hosted deployments, the shell resolves current membership
and tenant selection. Client-provided tenant IDs, headers, paths, queued payloads
or email domains never establish authority on their own.

Core enforces resource ownership/permissions within that trusted scope. Adapters
constrain storage and execution to the same scope. Missing/mismatched scope fails
closed, with no implicit fallback tenant. The self-host runtime binds a configured
single scope and supplies local authentication/access policy; it uses the same
operation checks. An unauthenticated loopback smoke runner is not a network-safe
self-host server.

Carry scope through reads/writes, listings, object keys, cache keys, search/vector
indexes, jobs/retries, idempotency, exports, deletion and audit events. Avoid global
mutable current-tenant state and unscoped shared stores. Define revocation and
background-job authorization semantics when those features arrive. Authenticate
and audit privileged/support operations separately.

With the first resource operation, test missing/forged scope and within-scope
permissions. Before sharing infrastructure, test two tenants with colliding local
IDs: A cannot read, mutate, list, search, export or delete B's resources; jobs and
retries preserve scope; caches/idempotency cannot collide; revocation follows the
documented policy. Single-tenant deployment does not replace these core checks.

## Release gates and current limits

For each product feature, demonstrate a useful path using only this repository
and documented customer-controlled dependencies. Run domain tests without
WorkOS/OpenCrawl credentials; test reference and hosted adapters against the
same contracts. Import checks catch accidental coupling, not arbitrary network
calls or authorization defects; review data/control flow as well.

Before claiming a supported self-host distribution, verify clean installation,
authentication for network exposure, a meaningful product operation, persistence
across restart, backup/restore, migration/upgrade and rollback expectations,
resource limits and support boundaries. Public source and install artifacts must
not require private GitHub Packages access. Select a public license explicitly,
review asset/dependency rights, and document security/contribution policies before
calling this open source. The current repository remains private and UNLICENSED.

As audited on November 4, 2026 at `c40f477`, the package still exports only
`hello()`/`renderHello()` and the loopback smoke runner. CLI enrollment and optional
Airbyte/session landing tools exist separately; the product indexer is not built.
Those tools do not constitute a complete authenticated self-host product, and
the greeting cannot prove resource authorization or multitenant isolation.

The session receiver also needs hardening before direct network exposure: its
current direct-run default is `0.0.0.0` with an optional token. Host/Origin checks
do not authenticate non-browser clients. Compose's loopback port publication
limits that path, but is not a substitute for requiring authenticated access on
non-loopback listeners. Verify startup defaults and negative credential tests
before claiming a network-safe reference deployment.

Publish tested immutable core runtime versions. The hosted consumer advances its
package version, integrity lock and Git source pin together; it verifies embedded
source revision. Documentation/test-only changes need no runtime publication.
