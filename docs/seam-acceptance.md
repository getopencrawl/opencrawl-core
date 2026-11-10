# Core and hosted shell acceptance

This branch implements a single-organization, multi-user product using local
Better Auth accounts. Cloud continues to use WorkOS through a separate adapter.
The repositories remain private release candidates; the checklist concerns runtime
independence, not public availability.

- [x] A clean server can build and start the complete OSS app with Docker Compose
  using only this repository and operator-owned dependencies/credentials, with
  OpenCrawl-operated services blocked.
- [x] Multiple local users in one configured organization can use the OSS app;
  current membership, roles, revocation and private resources are enforced by
  the server. Foreign organization claims and caller-selected scopes fail closed.
- [x] OSS imports a real source through the operator's Airbyte and OpenSearch,
  retrieves it through the UI and an agent, and passes restart, deletion and
  backup/restore checks.
- [x] OSS and the cloud candidate execute the same core-owned noncommercial
  UI and product operations through explicit adapters.
- [x] Shell contains hosted tenant provisioning/selection/routing, commercial
  policy, fleet operations and internal administration. Reusable product
  behavior has a working OSS implementation.
- [x] The isolated cloud candidate passes real source-to-retrieval and tenant
  isolation checks, preserves existing behavior, and has a verified rollback.

Candidate work must not change main or migrate, deploy over, or mutate existing
production data. Any verification resources require fresh names/namespaces.
The cloud preview uses staging WorkOS authentication and a tailnet address.
Once verified, publish branch revisions, clean-server Compose instructions,
preview address and exact evidence limits to the workspace board for independent
verification. Do not announce completion from synthetic fixture tests.

## Better Auth / WorkOS checkpoint — 2026-11-10

Core runtime `220fc6029e10483ed669844763cb1a6db7908c1c` is published privately as
`0.3.0-seam.7`. The self-host composition uses Better Auth 1.7.19 and its OAuth
provider plugin, SQLite identity storage, and the existing core authorization and
product operations. Cloud retains WorkOS cookies, CLI device authentication,
Connect MCP tokens and hosted organization selection. The identity directory
copies plain facts across the seam; SDK sessions, signing secrets and provider
objects do not become domain contracts. See [identity seam](identity-seam.md).

A fresh Compose project with empty application, S3, OpenSearch and Temporal volumes
runs on the isolated Ubuntu preview host. No old WorkOS users or application data
were migrated. WorkOS configuration is absent, and known WorkOS/OpenCrawl service
hostnames are blocked in both OSS app and worker containers.

Live OSS checks cover React setup, one-time invitations, two local accounts,
login/logout, role changes, portable CLI device login and refresh, MCP login,
consent and PKCE, capture, and real GitHub import through operator Airbyte into
OpenSearch. Both local accounts search and fetch the fixture with CLI and MCP;
the React search inspector returns the same commit. Password recovery rejects
old browser, CLI and MCP credentials and refresh grants. The standard OpenID
metadata path and the organization-bound indexing command were checked on the
final runtime. Unit tests cover bootstrap races, membership removal, malformed or
wrong-kind tokens and origin/rate-limit enforcement.

An offline backup at `bb31f00` restored into separate empty volumes; local identity,
OAuth refresh grants, real-source results and captured sessions remained usable.
Original volumes were retained and resumed. This was a test-installation restore,
not a migration of previous deployments. The follow-up `220fc60` change adjusts
metadata routing and an operator command; it changes no persisted schema.

Cloud's retained WorkOS browser session, CLI refresh and agent capture, real GitHub
MCP retrieval, and bidirectional tenant isolation passed with this identity seam.
Provider tokens are rejected by the other deployment. A new Google browser
sign-in remains an additional pending operator check. Existing WorkOS sessions
and grants remain usable; no provider configuration was changed.

Core tests: 321 passed, 24 optional integration skips locally; clean core CI and
private publication passed. Shell tests: 498 passed, 5 skips; branch CI includes
strict React checks, browser regressions and infrastructure typechecks. No main
merge or production deployment occurred. Independent clean-box verification is
ready for review through the workspace board. Live connector evidence covers the
restricted GitHub fixture, not every provider or a load benchmark. Self-host
Google login, passkeys, SSO and a support impersonation UI are not configured in
this release. Local account password recovery is an operator command.

## Historical WorkOS preview evidence

The following records describe the earlier WorkOS-based standalone candidate.
They preserve lifecycle and boundary history; they do not describe the current
OSS identity requirement or substitute for the Better Auth checks above.

Core owns the application composition, Sources and Team screens, product RPC
protocol and client, console operations, WorkOS verification and team operations,
Airbyte client, connector lifecycle, durable creation recovery, import counts and
operator-owned GitHub App adapter. Shell composes Billing and workspace selection,
hosted credential brokerage, destination policy, provisioning and fleet discovery.

At runtime revision `735d26b875697f458ea355ba1d413d1220e40722`, a fresh Ubuntu
24.04 amd64 server built this repository and ran all six default Compose services.
Real operator-owned staging WorkOS browser sign-in and published CLI login/refresh
passed for the configured organization. A task-created session was captured,
indexed by Temporal into OpenSearch, and retrieved through the authenticated CLI
search API. A foreign organization claim was rejected with HTTP 403.

An offline `deploy/backup.mjs` backup restored into newly named empty volumes at
the same Git revision; all services became healthy and the retained capture was
retrievable after login. The original volumes were preserved and resumed. With
known OpenCrawl-operated hostnames blocked in the app and worker containers,
identity and capture search still worked. This verifies the core-only deployment
and capture path, not the real-source predicate.

Core CI passed unit, browser, package/container, and real Temporal/S3/OpenSearch
checks. The cloud candidate consumes published core `0.3.0-seam.0` at that same
runtime revision; the source build of this repository does not require access to
that private package registry.

Live membership revocation also rejected an existing OSS token immediately,
without affecting its access to the separate cloud test organizations. Reactivation
restored access. Changing the existing browser user's role to member denied an
admin diagnostic request; restoring admin made the same session work again.
A second staging WorkOS user subsequently captured its own session, read a team-visible session, and lost search/fetch/raw-batch access when the owner made that session private. The owner retained access. This exposed and fixed a raw-batch privacy bypass in core `88b89b0`; the live raw read now returns 404. The same second user also read a shared memory, then lost search and saved-passage fetch access when its owner made it private. The owner retained both accesses.

Real GitHub imports now passed on both OSS and Cloud A: Airbyte jobs 1 and 2
completed, Temporal indexed the fixture commit, and both the React UI and authenticated
MCP search/fetch returned its source URL and content. OSS retained that result after
upgrading to core `88b89b0` / `0.3.0-seam.1`. Cloud A uses that same core package
through shell `4b4b363`. Cloud B could neither search nor fetch Cloud A's source.
All task-only GitHub and MCP consent flows are complete.

The Cloud B connection exposed an existing-installation GitHub callback problem.
Core `eb0b1dd` / `0.3.0-seam.2` fixed it with OAuth-first connection, explicit
installation selection, and a fixed set of user-visible repository IDs. Cloud B
then imported the real fixture and retrieved it through the UI and MCP. Both cloud
organizations retrieved their own copy and rejected the other's saved passage ID.
Cloud B disconnect removed its eight landed objects, indexing schedule and indexed
documents; search and saved fetch remained denied after a worker restart. Reconnect
reused the existing GitHub installation without changing its permissions.

Core `48c7d09` / `0.3.0-seam.3` limits startup recovery to unfinished connections
and continues recovering other records after a failure. Local tests passed 304
checks (24 optional skips); core and self-host CI passed. The OSS preview runs this
revision and retained its real-source retrieval after replacement.

The final placement review found shared product authentication, team operations,
UI, integration lifecycle, provider definitions, Airbyte client, indexing and
retrieval in core. Shell imports those implementations and supplies tenant routing,
managed credentials/storage, fleet discovery, billing and workspace UI extensions.
The source guard and browser/adapter tests complement the live paths above.

Final lifecycle checks passed at core `48c7d09`: an offline backup with the external
Airbyte connection paused restored into fresh empty volumes. Browser and MCP
retrieved the real source and retained capture; second-user private-memory and
session denial remained intact. The restored copy was stopped and the original
volumes resumed. OSS disconnect then removed twelve landed objects, its Airbyte
connection, indexing schedule and index documents. App/worker restart did not
restore access. Reconnect reused the installed GitHub App, completed Airbyte job
11 with four rows and returned the new result; the old saved ID remained denied.

Cloud B's replacement import also completed (job 10, four rows). Cloud shell
`eab3d747d` / core `48c7d09` passed real-source retrieval and bidirectional isolation,
then the retained shell `4b4b363` / core `88b89b0` did too. Returning to the current
image passed the same checks; connector actions were reopened. All six predicates
above now have evidence. See the shell's dated checkpoint and credential-free
receipts. Independent peer verification is the next review step.

The repositories remain private and both PRs remain drafts; advancing main now
conflicts with these branches and needs a separate integration review. No merge,
existing-data migration or production replacement occurred. Live provider evidence
covered GitHub, not every connector or a load benchmark. WorkOS was required for
that historical standalone candidate; the current OSS runtime uses Better Auth.
