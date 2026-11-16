# Linear through Airbyte

Linear uses the shared Airbyte declarative runtime and the operator-owned OAuth
credential proxy. Enable Airbyte and configure the optional Composio project as
described in [self-hosting](self-host.md). An active OpenCrawl administrator connects
Linear from Integrations and grants read access. No OpenCrawl-hosted account is
required. The source receives a connection-specific revocable capability, never
the broker key or a general GraphQL proxy.

## Source contract

The checked-in `src/integrations/connectors/linear.json` is the source definition;
it runs on the same pinned declarative image as the other connectors. It does not
use Airbyte's general-purpose `source-linear` image. Core's `linear-source.mts`
owns its fixed read-only GraphQL operations. References:
[Linear schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql),
[pagination](https://linear.app/developers/pagination), and
[Airbyte's Linear source](https://docs.airbyte.com/integrations/sources/linear).

Two streams, `issues` and `comments`, use hourly full-refresh append snapshots.
They request 50 records per page and exhaust `pageInfo.hasNextPage`, including
archived resources. Empty pages after access filtering still advance the cursor.
Cursor checkpoints detect cycles across independent proxy requests. GraphQL
errors, including HTTP-200 partial failures, fail the page; they never become
successful empty imports. Airbyte retries proxy failures with a bounded backoff.
This first version rereads history; it has no incremental lookback cutoff.

Issues retain their identifier, title and Markdown description. Comments retain
their complete body and the parent issue title. Both retain the native URL and
`updatedAt`. Only issue comments are included. Projects, documents, initiatives,
customer requests, attachment bodies, reactions, user inventories and comments
without an accessible parent issue are excluded. Link text present in bodies is
retained; external links and attachments are not fetched.

## Access, identity and updates

An administrator shares public-team content with the OpenCrawl workspace.
Linear `Team.visibility` must be exactly `public`; `private`, `restricted`, and
missing visibility are excluded. A restricted team inside a private parent is
not public even if the deprecated `private` boolean is false. The authenticated
Linear organization and each issue's team organization must match the stored
connection workspace. Trashed issues and their comments are excluded.

Each immutable gzip JSONL row uses the shared Airbyte envelope under
`raw/v1/source=linear/workspace=<Linear organization UUID>/connection=<integration>/`.
Streams follow the shared date/sync partition grammar. The source attaches a
tenant-, connection-, workspace- and content-bound public-team receipt. This is
collection-time evidence, not a permanent authorization grant. Normalization
rejects missing or mismatched receipts and uses only the explicit content fields.

Search and fetch both inspect the current issue/comment and its current team
through the authenticated provider connection. Missing policy, API failure,
workspace change, deletion, private/restricted teams and disconnect fail closed.
Older runtimes keep Linear unavailable until they install both the source proxy
and the resolver's `linearAccess` adapter. No new index or routing is introduced.

Resource identity is `issue:<UUID>` or `comment:<UUID>`, additionally scoped by
tenant, provider, workspace and connection. Long bodies use the shared passage
format and current-parent revision barrier. `updatedAt` controls update ordering;
replay preserves identity and legitimate shorter edits replace older content.
Objects are receipted only after writes succeed. Absence from a snapshot does not
erase raw history or infer a tombstone; live resource checks suppress deleted or
revoked resources while normal connection deletion uses the shared purge path.

## Validation and rollout

`test/linear.test.mjs` exercises source filtering, restricted teams, capability
isolation, pagination cycles, partial GraphQL errors, receipt validation, edits,
replay and authenticated search/fetch with SQLite and service-backed OpenSearch.
`test/connector-runtime.test.mjs` checks discovery and paginated reads of both
streams on the pinned real Airbyte runtime. CI runs the service-backed cases.
These are fixtures, not a live Linear workspace completeness audit.

Publish the tested core runtime before advancing the hosted package, integrity
lock and source pin together. The hosted adapter must register the manifest,
route its two source endpoints through `createLinearSource`, supply
`linearAccess` to `createConnectorResolver`, enable `linearPublicAccess` in the
catalog and serve the shared Linear icon. Then verify OAuth, a real Airbyte sync,
landed records and authenticated search/fetch before claiming a live rollout.
Rollback the hosted pin and stop new Linear syncs; previously landed data stays
scoped and unavailable to older runtimes without the permission adapter.
