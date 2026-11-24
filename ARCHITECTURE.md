# Single-tenant core and hosted shell

## Contract

OpenCrawl core must provide a useful single-tenant product on infrastructure a
customer controls, without access to the proprietary shell, an OpenCrawl
account, or our control plane. One tenant is one customer/security boundary;
it supports multiple users in one local organization. Basic security is part of core's
self-hosted distribution, not a proprietary add-on.

The hosted shell adds managed multitenancy and operation around the same product
implementation. Both the self-host runtime and hosted shell depend on core-owned
contracts; core never depends on the shell. No hosted entitlement checks,
provider user/session objects, mandatory hosted telemetry, or `isCloud` branches
in domain logic. No duplicated hosted version of a core operation.

## Placement

Core owns the complete noncommercial UI, reusable identity adapters and
team operations, capture, board, sessions, memories, connector lifecycle,
Airbyte clients, indexing, search, resource permissions and data lifecycle.
Search uses a core-owned realm adapter contract. OpenSearch and opt-in SQLite
FTS5 preserve the agent API; matching/ranking parity is not guaranteed. See
`docs/search-backends.md` for the conformance floor and operational limits.
Self-hosters operate local Better Auth accounts and supply Airbyte,
their selected search backend, connector credentials and documented supporting storage/jobs.
The optional Composio adapter uses an operator-owned project for connector OAuth;
it is not an OpenCrawl account or control-plane dependency. Missing connector
configuration remains visible in the product catalog with setup guidance.

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
The CLI embeds Bun in each platform executable. Native installation is preferred;
npm runs Node at installation time to place that same executable. Commands,
hooks and updates run inside the executable. Versioned installs preserve active
processes and capture state; see `cli/README.md` for migration and recovery.
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
operation checks.

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
across restart, backup/restore,
resource limits and support boundaries. Public source and install artifacts must
not require private GitHub Packages access. The repository is public. Core and CLI are
Apache-2.0; plugins remain MIT. Vendored Airbyte source manifests retain their
own licenses (see `src/integrations/upstream/linear/LICENSE`). See docs/self-host.md for the supported preview.

Session capture uses the authenticated full application. Both it and the
hosted shell land immutable gzip batches and attachment blobs through the same
S3-compatible adapter and schema. Self-hosted deployments must configure an
object-store bucket (AWS S3 or a compatible service); filesystem storage is only
an internal test helper. Downstream ingestion must share the S3 object contract
across deployments. The CLI's local spool is a retry buffer, not a separate
server-side source. The shared OpenSearch worker enforces explicit scope; the
supported application runtime fixes one organization and verifies every user.
The hosted adapter supplies
its authorized scope resolver. See `docs/session-indexing.md`.

Publish tested immutable core runtime versions. The hosted consumer advances its
package version, integrity lock and Git source pin together; it verifies embedded
source revision. Protected main publishes immutable development revisions after
its required checks. Stable tagged distributions retain independent release
gates; see [continuous delivery](docs/continuous-delivery.md).

## Organization search realm

A tenant's connector documents, session histories and memories share one
organization search realm per environment. Board storage and search use PostgreSQL;
legacy derived board documents remain readable for index migration. Core owns its common envelope, typed metadata,
index naming, transport, scope checks and migration primitives. Source adapters
retain resource visibility checks. The shell supplies verified identity, managed
routing and safe migration/cutover; it must not introduce per-feature index layouts.

## Shared application seam

The single-tenant product uses Better Auth with local accounts in an operator-owned
PostgreSQL application database. Cloud continues to use WorkOS. Both adapters expose core-owned
identity directory facts; provider sessions and tokens stay at their runtime boundary.
Reusable authentication, membership, role controls, UI, Airbyte and connector
lifecycle implementations belong in core. Hosted multi-tenant selection and
provisioning, billing, fleet operation and internal administration belong in
shell. Source SDK names do not determine ownership. Core requires no account
or service operated by OpenCrawl. This contract supersedes earlier hosted-only
classification of reusable identity, integrations and product UI.

The reconciled runtime keeps PostgreSQL authoritative for Better Auth, the
integration registry, board messages/delivery, and capture event identities.
Remaining product state uses the proven production object-store contracts.
Do not reintroduce a second runtime core version or require a whole-application
migration for ordinary feature delivery. Network shared-file contents and refs live in native bare Git repositories on operator-owned persistent storage. PostgreSQL owns their volume identities and indexes authenticated pushes from the durable Git reflog. Other new application state belongs in PostgreSQL; move
existing domains individually with their own tested cutover and recovery plan.

Temporal runs session indexing/deletion and connector indexing. Deployments can also bind the shared durable adapter for guarded team role changes and removals. A team workflow loads an authenticated operation reference from PostgreSQL. The existing object-store guard still serializes organization changes and holds unknown provider outcomes for operator reconciliation.
The unfinished connector-lifecycle rewrite and online whole-state migration
have been retired. Preserve current authorization and idempotency behavior.
Self-host startup initializes and verifies an empty application database
(`src/state/initialize.mts`). There is no upgrade path from older versions
during alpha; an older installation keeps its release or starts from an empty
install.

## React document seam

All feature UI is rendered by the shared React application. Core owns auth
outcomes, provider callbacks and capture setup; shell supplies hosted organization
selection/provisioning and its service-specific legal page through the document
extension. Servers retain authorization, cookies, redirects and HTTP status, and
supply only an empty app mount plus escaped inert JSON. No alternate HTML renderer
or feature stylesheet is retained. The same core Page, controls and tokens serve
focused documents and the workspace console.

Shared integration changes require a verified active admin membership bound to
the principal and organization. Runtime adapters pass plain membership facts to
core; UI controls reflect these permissions but never grant them.

## Context suggestions extension

Core owns bounded context suggestions, judgment and lifecycle-event contracts,
source authorization and the lexical self-host adapter. Self-host startup may
load `OPENCRAWL_CONTEXT_SUGGESTIONS_MODULE`, an explicit absolute local path to
trusted operator code exporting a per-request judgment factory and/or observer.
This is a composition boundary, not a sandbox: no request selects a module,
remote URL, model credential or hosted fallback. The hosted shell supplies its
private judgment policy, credit ledger and managed telemetry retention. Public
harness plugins own hook definitions/runners; the CLI installs those assets and
writes deployment configuration, preserving native trust and disabled choices.
