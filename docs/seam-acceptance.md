# Core and hosted shell acceptance

This branch implements a single-organization, multi-user product using the
operator's own WorkOS account. It remains a candidate until every item below
has evidence. Moving code alone does not satisfy the self-host promise.

- [ ] A clean server can build and start the complete OSS app with Docker Compose
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

## Extraction checkpoint

Core owns the application composition, Sources and Team screens, product RPC
protocol and client, console operations, WorkOS verification and team operations,
Airbyte client, connector lifecycle, durable creation recovery, import counts and
operator-owned GitHub App adapter. Shell composes Billing and workspace selection,
hosted credential brokerage, destination policy, provisioning and fleet discovery.

The standalone application, direct connector credentials, clean-server install
and live acceptance work remain in progress. Existing capture-only entrypoints
and the reduced reference console do not satisfy the complete application gate.
