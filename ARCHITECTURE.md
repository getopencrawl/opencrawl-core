# Single-tenant core and hosted shell

## Contract

OpenCrawl core must provide a useful single-tenant product on infrastructure a
customer controls, without access to the proprietary shell, an OpenCrawl
account, or our control plane. One tenant is one customer/security boundary;
it supports multiple users in one configured WorkOS organization. Basic security is part of core's
self-hosted distribution, not a proprietary add-on.

The hosted shell adds managed multitenancy and operation around the same product
implementation. Both the self-host runtime and hosted shell depend on core-owned
contracts; core never depends on the shell. No hosted entitlement checks,
provider user/session objects, mandatory hosted telemetry, or `isCloud` branches
in domain logic. No duplicated hosted version of a core operation.

## Placement

Core owns the complete noncommercial UI, reusable WorkOS authentication and
team operations, capture, board, sessions, memories, connector lifecycle,
Airbyte clients, indexing, search, resource permissions and data lifecycle.
Self-hosters supply their own WorkOS account and one organization, Airbyte,
OpenSearch, connector credentials and documented supporting storage/jobs.

The proprietary shell owns hosted tenant selection and provisioning, billing
and commercial policy, fleet scheduling, internal support and administration,
and account-specific managed infrastructure. It consumes core-owned product
interfaces and adds UI extensions. SDK/vendor names do not determine ownership.

Classify by responsibility. A local HTTP server, self-host authentication adapter,
Compose/Helm example, or optional S3-compatible client can live here. Keep these
adapters out of domain logic. Selecting an AWS storage option must not require
every user to have AWS credentials. Third-party services retain their own
licenses; bundling or offering them as managed services needs separate review.

`src/` contains the package runtime, `web/` shared assets, `web-v2/` the React
console, `cli/` the independent client, and `deploy/` the single-tenant stack.
Add seams only alongside an implemented feature and a working reference adapter;
an interface without a usable implementation does not deliver self-hosting.
Do not retain disconnected ingestion tools or superseded UI implementations.

## Trust and scope

The runtime verifies credentials and supplies a provider-neutral principal and
authorized scope. In hosted deployments, the shell resolves current membership
and tenant selection. Client-provided tenant IDs, headers, paths, queued payloads
or email domains never establish authority on their own.

Core enforces resource ownership/permissions within that trusted scope. Captured
sessions and memories are readable by every member of the tenant unless their
uploader marks them private; a private resource is readable and searchable only by
its uploader. Visibility changes and deletion are owner-only operations in core
(`docs/sessions-and-memories.md`); every read path applies the same filter. Adapters
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
calling this open source. The repository remains private while preparing release. Core and CLI are
Apache-2.0; plugins remain MIT. See docs/self-host.md for the supported preview.

Session capture now has an authenticated single-tenant receiver. Both it and the
hosted shell land immutable gzip batches and attachment blobs through the same
S3-compatible adapter and schema. Self-hosted deployments must configure an
object-store bucket (AWS S3 or a compatible service); filesystem storage is only
an internal test helper. Downstream ingestion must share the S3 object contract
across deployments. The CLI's local spool is a retry buffer, not a separate
server-side source. The shared OpenSearch worker enforces explicit scope; the
supported application runtime must fix one organization and verify every user;
the older capture-only entrypoint fixes one tenant/user. The hosted adapter supplies
its authorized scope resolver. See `docs/session-indexing.md`.

Publish tested immutable core runtime versions. The hosted consumer advances its
package version, integrity lock and Git source pin together; it verifies embedded
source revision. Documentation/test-only changes need no runtime publication.

## Organization search organization

A tenant's connector documents, session histories and board messages share one
organization realm per environment. Core owns its common envelope, typed metadata,
index naming, transport, scope checks and migration primitives. Source adapters
retain resource visibility checks. The shell supplies verified identity, managed
routing and safe migration/cutover; it must not introduce per-feature index layouts.

## Shared application seam

The single-tenant product supports multiple users through the operator’s own
WorkOS account. WorkOS is the supported identity adapter for this iteration;
reusable authentication, membership, role controls, UI, Airbyte and connector
lifecycle implementations belong in core. Hosted multi-tenant selection and
provisioning, billing, fleet operation and internal administration belong in
shell. Source SDK names do not determine ownership. Core requires no account
or service operated by OpenCrawl. This contract supersedes earlier hosted-only
classification of reusable identity, integrations and product UI.
