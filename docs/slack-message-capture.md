# Canonical Slack history capture

Slack search results are not a complete source inventory. They can have a
backfill filter, omit messages, or return a different fallback representation
from `conversations.history` and `conversations.replies`. The optional core
message capture enumerates every API-visible public channel, including archived
channels, exhausts history cursors with no `oldest` filter, and exhausts replies
for every returned parent with replies. Old parents remain eligible for recent
replies. Private channels and DMs are outside this contract.

Use `createSlackMessageCapture` from `@getopencrawl/opencrawl-core/connectors/slack-source-messages`
with an explicit validated binding, scoped object store, and a workspace-verified
read adapter. The customer-operated HTTP adapter verifies `auth.test`. The
standalone runner accepts the same config as [file capture](slack-file-capture.md):

```sh
node dist/src/connectors/slack-source-standalone.mjs config.json stable-run-id messages
```

The config must retain a stable epoch-millisecond `cutoff` across restarts.
Capture writes exact API pages and cursor checkpoints under
`capture/messages-v1/<run-id>/` beneath the bound raw prefix. Normalized input
lands as immutable gzip Airbyte-shaped envelopes in `stream=canonical_messages/`;
the channel ID comes from the enumerated/requested public channel. No source text
or credentials belong in workflow arguments, results or history.

`captureSlackMessagesV1` uses the shared source worker, activity retries,
durable timers and continuation after 100 steps. Checkpoints preserve separate
65-second history/reply pacing and longer `Retry-After` values. Reservations are
saved before requests, so transport failures and activity retries retain pacing. The runtime
rechecks connection identity and bucket scope before writes. API failures remain
explicit failed-resource counts; a workflow with such failures does not succeed.
Operators must coordinate independent audits with capture because the provider's
rate budget is shared across callers.

The shared pagination guard also covers channel enumeration, each channel's
history, and each thread's replies. Progress belongs to that cursor's scoped
run/cutoff checkpoint; it survives restarts and continuations, resets at terminal
pages, and never crosses channel/thread boundaries. Advancing empty pages remain
valid. Cycles fail before publishing the offending page or messages through the
existing nonretryable `InvalidSlackSource` activity boundary. Legacy checkpoints
remain usable; the same retry and rollback rules as [file capture](slack-file-capture.md)
apply. Opaque cursor values are not included in the failure message.

Canonical messages share native message identity with existing Airbyte records.
Their explicit `sourceAuthority` makes direct history authoritative over search
previews even if the preview is delivered later. Newer canonical observations
still replace older ones, including legitimate shorter edits. Durable suppression
always wins. This policy can delay an edit seen only in search until the next
canonical pass; operate and monitor capture accordingly. Never choose the longest
body as an edit-ordering rule.

Message capture also keeps `capture/messages-v1/catalog.json`, recording public
channel identities before publishing them. After a complete channel enumeration,
it emits non-public metadata for previously observed channels that are no longer
returned; a partial enumeration never does so. This works without file capture.
The catalog begins with channels observed by this version; it cannot infer
identities missing before the catalog existed. Before upgrading an existing
index, seed the historical identities using the portable upgrade operation below.

This capture is a snapshot, not a deletion feed. Incremental absence does not
delete a message. Current channel visibility and explicit resource suppression
still gate search. File bodies require the separate file-capture operation.
API scopes, retention, inaccessible histories, pagination failures, and messages
newer than the cutoff must appear in coverage reports. A successful workflow
alone does not prove completeness: reconcile its API page identities and all
readable source fields with raw objects, index records and authenticated retrieval.

## Upgrade existing access catalogs

Serialize catalog seeding with file and message captures for the connection.
Use the operator-trusted binding and its scoped store. Enumerate all existing
indexed channel and file identities for that binding, with exhaustive pagination
and scope checks, or derive the same identities from retained `channels` and
`file_documents` raw envelopes. Include previously unavailable identities: the
catalog remembers observations; it does not grant access.

```js
import {seedSlackSourceCatalog} from '@getopencrawl/opencrawl-core/connectors/slack-source-messages';

await seedSlackSourceCatalog({
  binding, store,
  channelIds, // Native IDs from channel sourceId/channel_id metadata.
  fileShares, // [{fileId, channelId}] from file manifests or raw file records.
  checkActive, // Revalidate the operator-authorized binding before each write.
});
```

The same helper is exported from `@getopencrawl/opencrawl-core/connectors/slack-source`.
It validates both stored catalogs against the binding, unions their existing
channel/share identities with the supplied ones, and writes both catalogs. It
accepts up to 100,000 input channel IDs and 100,000 input share pairs; each catalog
is bounded at 16 MiB. It never deletes source/index data or marks a resource
public. Retry the same operation after an interrupted write: already committed
identities are preserved. Do not run it concurrently with capture, because the
two catalog writes are not a cross-object transaction.

Resume capture and indexing after seeding. Verify that a complete current channel
enumeration has landed, indexed metadata agrees with current visibility, and
removed channels cannot be retrieved. File capture separately reconciles known
file shares against current `files.info` results. Existing catalogs alone may
omit identities published by older versions, so they are not sufficient input
for an upgrade audit without checking the index or retained raw records.

## Refresh known messages

A finite set of known messages can be refreshed with
`createSlackMessageReferenceCapture` from
`@getopencrawl/opencrawl-core/connectors/slack-source-message-references`, or the
`captureSlackMessageReferencesV1` workflow on the existing source worker.
The standalone runner supports `references` mode with config:

```json
{"references":[{"channelId":"C123","ts":"1793965360.600579"},
 {"channelId":"C123","ts":"1793965361.000001","threadTs":"1793965360.600579"}]}
```

Add these references to the existing binding/S3 config. The operation accepts
1–1000 unique native identities, checks `conversations.info` for a public channel
(including archived channels), and reads the exact inclusive timestamp range
through history or replies. The workspace-verified adapter must support
`conversations.info`. Capture preserves native fallback text and blocks, including
accessibility text that a search connector's synthesized fallback may omit.

Checkpoints and exact API pages live under
`capture/message-references-v1/<run-id>/`. A run ID binds the ordered reference
set and authorized scope; use the same inputs to resume. Raw envelopes land in
`stream=canonical_messages/` and use the existing normalizer, source authority,
receipts and indexing queue. No index-generation change is needed when only the
source acquisition changes. An absent message is a failed reference, not a
verified deletion. Scope changes and malformed/partial responses fail closed.

This is supplemental observation of named resources, not a full inventory or
an extension of a prior census cutoff. Preserve both observation windows in the
audit. Serialize reference refreshes with full captures for the same workspace:
method pacing is durable within each run, while Slack quota is shared across all
callers. The workflow does not acquire a global quota lock. Operators must avoid
competing full and targeted captures and must not suspend another ingestion
system to make an audit appear complete. After capture, reconcile native fields,
raw identities, successful receipts, exact indexed bodies and authenticated
retrieval before closing the repair.
