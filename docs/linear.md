# Linear

OpenCrawl uses Airbyte source-linear 1.0.3, pinned to the revision in
`src/integrations/upstream/linear/provenance.json`. It supports all 20 upstream
streams: issues, comments, users, teams, cycles, labels, workflow states,
attachments, issue relationships and history, projects, project updates,
milestones and statuses, initiatives and their project links, customers,
customer needs, customer statuses and tiers. Project content is included.
Airbyte does not currently provide a standalone Linear documents stream.

Fourteen streams resume from their upstream `updatedAt` cursor; the other six
use full refresh. The first sync starts at the beginning of available history.
Airbyte's exact pinned manifest is distributed with its own Elastic License 2.0.
The OpenCrawl transport and permission adapters are Apache-2.0.

An administrator connects an operator-owned Composio project using Linear's
user-mode `read` scope, which inherits the consenting user's resource access.
The upstream app-mode OAuth flow uses `customer:read` and `initiative:read`;
those scopes are invalid for Composio's user-mode authorization. The broker owns OAuth tokens;
Airbyte receives a revocable capability restricted to one connection's upstream
read queries. Setup reads Linear's `organization.customersEnabled` flag. When
false, it omits `customers` and `customer_needs` from the selected catalog;
customer statuses and tiers remain available. All 20 streams are selected when
the feature is enabled. Other unsupported or revoked permissions fail the sync
visibly; they are never
reported as an empty successful sync.

Connecting shares organization-wide references and resources belonging to
public teams with OpenCrawl workspace members. Private/restricted teams are
excluded. Projects and related records require every associated team to be
public; an incomplete team list is denied. Initiatives must be public, and
relationship records require both parents to be public. Current permission checks
run before raw records are released, again before indexing, and on search/fetch.
Disconnect immediately invalidates the source capability and retrieval.

Changing a formerly private team's visibility may not update its children's
`updatedAt`; run a full source refresh to collect those newly shared records.
Existing indexed records always receive fresh read authorization. The alpha
self-host distribution starts from an empty installation when replacing the
retired two-stream format; hosted rollout must explicitly account for existing
connections before adopting this source.

Validation: `npm test` requires an isolated PostgreSQL test database via
`OPENCRAWL_TEST_POSTGRES_URL`. `OPENCRAWL_TEST_CONNECTOR_RUNTIME=1 node --test
test/connector-runtime.test.mjs` exercises every stream, empty-page pagination,
upstream field transforms and cursor resume using the pinned Airbyte image.
`OPENCRAWL_TEST_OPENSEARCH_URL` additionally exercises ingestion and authenticated
retrieval against OpenSearch in `test/linear.test.mjs`.
