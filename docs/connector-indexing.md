# Connector indexing

For a new source, follow [Building a connector-to-search pipeline](connector-development.md).
The current implementation below is Slack-specific, not automatic support for every Airbyte source.

The Slack reader selects `channels`, `users`, `channel_members`,
`channel_messages`, and `threads` (plus the compatible `messages` alias).
Additional streams are counted as ignored when listing S3 pages; they do not
block selected streams or receive success receipts. A custom `replies` stream
is not automatically treated as stock `threads`. Unsupported paths inside a
selected stream and any out-of-scope key still fail closed.

The reusable path reads Airbyte JSONL.gz from an S3-compatible bucket and indexes
stock Slack `channel_messages`, `threads`, `channels`, `users`, and
`channel_members`. `messages` is also accepted as a channel-message stream alias.
This is lexical search; embeddings and thread summaries are not required.

The `slack-v5` normalizer includes fallback `text`, visible Block Kit and rich-text
content, menu option labels/descriptions/confirmation text, attachment
text/fields/blocks/service attribution, and both file names and titles. It deduplicates mirrored
fragments without treating a nonempty fallback or an ellipsis as proof of a
complete body. Binary attachments and content behind links are not fetched.
Unsupported future block structures need an explicit adapter update; arbitrary
metadata and interactive control values are never recursively indexed. The
256 KiB limit applies to the assembled readable message, with oversized records
failing visibly instead of being truncated.

Inline rich-text formatting preserves whole words and phrases; separate sections
retain line boundaries. Link destinations remain searchable outside the rendered
line. This also applies to quotes and preformatted text.

On an existing organization realm, v5 adds an integer `connector.normalizerVersion`
after validating tenant ownership and the previous mapping. New receipt keys force
raw replay. At the same observation time and source authority, v5 messages replace
the previous interpretation regardless of hash order. Older source observations
cannot undo newer edits, and suppression remains sticky. Drain old writers, deploy
the new worker, replay and verify all objects before claiming completion. Preserve
old receipts and source objects; do not clear or recreate the shared realm. A
rollback to an older writer requires coordinated replay verification because that
writer does not know normalization-version ordering.

Pre-realm flat indexes still require the explicit realm migration described in
[organization realms](organization-realms.md). Carry suppression records forward;
raw replay alone cannot reconstruct operator tombstones.


An operator-trusted binding fixes tenant, connection, Slack workspace, public-team
access policy and raw prefix. Workflow input contains opaque references only;
runtime adapters must resolve them against an authoritative registry on every
activity and before writes. Disconnected/reassigned connections fail closed.
Queries receive authorized active bindings; neither a user nor a queued payload
can select a bucket, tenant, index or arbitrary OpenSearch DSL.

Raw objects use:
`raw/v1/source=slack/workspace=<workspaceId>/connection=<connectionId>/stream=<stream>/date=<YYYY-MM-DD>/sync=<syncId>/<file>.jsonl.gz`.
Objects must be immutable. A successful receipt is per tenant, connection, raw key,
pipeline version and index target. Receipts are written after every bulk item
succeeds. Do not overwrite raw files; deliver corrections under new keys.
The reader streams gzip, bounds compressed objects to 256 MiB, expanded objects
to 1 GiB, lines to 2 MiB and message text to 256 KiB. Oversized, malformed or lossy
Airbyte records fail visibly and retain no success receipt. Already-written
records are safe to replay. Content is never placed in Temporal history.

Messages and thread-parent copies share IDs based on tenant, connection,
workspace, channel and exact string timestamp. OpenSearch applies atomic
extraction-time comparisons, with a deterministic content hash tie-breaker.
Retries and older deliveries cannot overwrite a newer observation. This orders
Airbyte observations, not unseen source edits. User/channel snapshots are upserts;
absence from a file never means deletion. A channel must have explicit public
metadata before its messages can appear in search. Search rechecks that metadata,
so a received private-channel update hides existing messages. Missing-channel and
source-revocation detection still depend on upstream signals.

`suppress` records an explicit durable tombstone and clears indexed text; even a
newer raw replay cannot resurrect it. It is not source deletion detection or an
S3 erasure API. Raw retention and permanent deletion require a separate operator
policy. There is deliberately no automatic unsuppress operation.

## Customer-operated path

From this repository, `npm ci` installs the tested runtime. Create a protected
configuration file (credentials stay in environment variables):

```json
{
  "binding": {
    "tenantId": "my-team", "connectionId": "slack-1", "workspaceId": "T123",
    "provider": "slack", "access": "team-public",
    "rawPrefix": "raw/v1/source=slack/workspace=T123/connection=slack-1/"
  },
  "s3": {"endpoint": "http://127.0.0.1:8333", "bucket": "my-bucket"},
  "search": {"endpoint": "http://127.0.0.1:9200", "index": "my-team-slack-v4"}
}
```

Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for your object store, then:

```sh
node src/connectors/standalone.mjs index /path/to/config.json
node src/connectors/standalone.mjs search /path/to/config.json 'release checklist'
```

The CLI is local and takes an operator-controlled scope; it exposes no network
listener. For network exposure, authenticate users and resolve authorized bindings
before calling the same core search API. OpenSearch basic auth is supported via
protected `search.username`/`search.password`; the hosted adapter uses SigV4.
Do not expose an unauthenticated object store or OpenSearch endpoint publicly.

## Durable Temporal adapter

The optional `connectors/temporal` export uses pinned `@temporalio/worker`,
`@temporalio/activity`, `@temporalio/common`, `@temporalio/client`, and `@temporalio/workflow` peers at
1.25.0. Install them explicitly when consuming the package. Core domain operations
remain independent of Temporal. `buildConnectorWorkflows` creates the immutable
workflow bundle; `createConnectorWorker` requires an explicit address, namespace,
task queue, bundle path and registry resolver. The adapter is identical for
customer-operated and hosted deployments. Only the resolver differs.

For the standalone worker, add `temporal` to the protected config above, with
`address`, `namespace`, and `taskQueue`. Create that namespace on your own
persistent Temporal server first. Then run:

```sh
node src/connectors/temporal/standalone.mjs /path/to/config.json /path/to/workflow-bundle.cjs
```

It creates a five-minute durable schedule and triggers its initial sweep. Restart
the process with the same config to resume polling; the schedule and workflow
state live in Temporal. The standalone config is a fixed, operator-trusted
authorization policy. Stop the worker and remove/pause its exact schedule before
revoking that fixed scope; hosted deployments recheck their connection registry.

`indexConnectorV1` scans at most five pages per execution before continuing as
new with the S3 cursor. Each activity retries five times and heartbeats while it
runs. A poison object does not prevent processing the rest of the page; the sweep
ends in a visible failure if any object exhausted retries. Schedule a new sweep
with overlap policy SKIP to retry repaired objects and find late arrivals. S3
receipts avoid reprocessing successfully indexed objects. Entire-prefix sweeps
are an initial bounded-memory discovery strategy, not an optimal large-corpus
notification architecture. Monitor scan duration and lag before expanding scale.

Reindex into a new index generation, which creates separate receipts; verify
results before changing the query target. Keep the previous index for rollback.
Back up raw S3 data and Temporal's persistent database. Restoring source data into
a fresh index rebuilds search; restoring only receipts without their matching
index is invalid. Raw-data loss cannot be recovered from Temporal pointers.

## Verification

`test/connector-pipeline.test.mjs` covers scope, retries, malformed input and
bounded reads. CI's `test/connector-live.test.mjs` exercises actual S3-compatible
storage and OpenSearch, including atomic stale-write rejection, suppression,
public-channel visibility and two tenants with colliding source IDs. These are
controlled fixtures, not proof of Slack source completeness or production load.
