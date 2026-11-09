# Core and hosted shell acceptance

This branch implements a single-organization, multi-user product using the
operator's own WorkOS account. It remains a candidate until every item below
has evidence. Moving code alone does not satisfy the self-host promise.

- [x] A clean server can build and start the complete OSS app with Docker Compose
  using only this repository and operator-owned dependencies/credentials, with
  OpenCrawl-operated services blocked.
- [ ] Multiple WorkOS users in one configured organization can use the app;
  current membership, roles, revocation and private resources are enforced by
  the server. Foreign organization claims and caller-selected scopes fail closed.
- [ ] OSS imports a real source through the operator's Airbyte and OpenSearch,
  retrieves it through the UI and an agent, and passes restart, deletion and
  backup/restore checks.
- [ ] OSS and the cloud candidate execute the same core-owned noncommercial
  UI and product operations through explicit adapters.
- [ ] Shell contains hosted tenant provisioning/selection/routing, commercial
  policy, fleet operations and internal administration. Reusable product
  behavior has a working OSS implementation.
- [ ] The isolated cloud candidate passes real source-to-retrieval and tenant
  isolation checks, preserves existing behavior, and has a verified rollback.

Candidate work must not change main or migrate, deploy over, or mutate existing
production data. Any verification resources require fresh names/namespaces.
The cloud preview uses staging WorkOS authentication and a tailnet address.
Once verified, publish branch revisions, clean-server Compose instructions,
preview address and exact evidence limits to the workspace board for independent
verification. Do not announce completion from synthetic fixture tests.

## Current verification checkpoint

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
A second staging WorkOS user subsequently captured its own session, read a team-visible session, and lost search/fetch/raw-batch access when the owner made that session private. The owner retained access. This exposed and fixed a raw-batch privacy bypass in core `88b89b0`; the live raw read now returns 404. Private-memory acceptance remains open.

Real GitHub imports now passed on both OSS and Cloud A: Airbyte jobs 1 and 2
completed, Temporal indexed the fixture commit, and both the React UI and authenticated
MCP search/fetch returned its source URL and content. OSS retained that result after
upgrading to core `88b89b0` / `0.3.0-seam.1`. Cloud A uses that same core package
through shell `4b4b363`. Cloud B could neither search nor fetch Cloud A's source.
All task-only GitHub and MCP consent flows are complete.

The Cloud B connection exposed an existing-installation GitHub callback problem.
The next candidate starts with OAuth, supports explicit installation selection,
and persists only the repository IDs visible to the connecting user. Its runtime
and connector changes still require live acceptance.

Still open: private-memory proof; GitHub reconnection and real-source deletion/restore;
Cloud B real-source retrieval and bidirectional isolation; updated rollback; final
placement review and independent handoff. Repository visibility and publication
remain unchanged. See the shell's dated evidence checkpoint for the receipts.
