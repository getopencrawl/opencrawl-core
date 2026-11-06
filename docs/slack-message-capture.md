# Canonical Slack history capture

Slack search results are not a complete source inventory. They can have a
backfill filter, omit messages, or return a different fallback representation
from `conversations.history` and `conversations.replies`. The optional core
message capture enumerates every API-visible public channel, including archived
channels, exhausts history cursors with no `oldest` filter, and exhausts replies
for every returned parent with replies. Old parents remain eligible for recent
replies. Private channels and DMs are outside this contract.

Use `createSlackMessageCapture` from `@1patch/opencrawl-core/connectors/slack-source-messages`
with an explicit validated binding, scoped object store, and a workspace-verified
read adapter. The customer-operated HTTP adapter verifies `auth.test`. The
standalone runner accepts the same config as [file capture](slack-file-capture.md):

```sh
node src/connectors/slack-source-standalone.mjs config.json stable-run-id messages
```

The config must retain a stable epoch-millisecond `cutoff` across restarts.
Capture writes exact API pages and cursor checkpoints under
`capture/messages-v1/<run-id>/` beneath the bound raw prefix. Normalized input
lands as immutable gzip Airbyte-shaped envelopes in `stream=canonical_messages/`;
the channel ID comes from the enumerated/requested public channel. No source text
or credentials belong in workflow arguments, results or history.

`captureSlackMessagesV1` uses the shared source worker, activity retries,
durable timers and continuation after 100 steps. Checkpoints preserve separate
65-second history/reply pacing and longer `Retry-After` values. The runtime
rechecks connection identity and bucket scope before writes. API failures remain
explicit failed-resource counts; a workflow with such failures does not succeed.
Operators must coordinate independent audits with capture because the provider's
rate budget is shared across callers.

Canonical messages share native message identity with existing Airbyte records.
Their explicit `sourceAuthority` makes direct history authoritative over search
previews even if the preview is delivered later. Newer canonical observations
still replace older ones, including legitimate shorter edits. Durable suppression
always wins. This policy can delay an edit seen only in search until the next
canonical pass; operate and monitor capture accordingly. Never choose the longest
body as an edit-ordering rule.

This capture is a snapshot, not a deletion feed. Incremental absence does not
delete a message. Current channel visibility and explicit resource suppression
still gate search. File bodies require the separate file-capture operation.
API scopes, retention, inaccessible histories, pagination failures, and messages
newer than the cutoff must appear in coverage reports. A successful workflow
alone does not prove completeness: reconcile its API page identities and all
readable source fields with raw objects, index records and authenticated retrieval.

## Refresh known messages

A finite set of known messages can be refreshed with
`createSlackMessageReferenceCapture` from
`@1patch/opencrawl-core/connectors/slack-source-message-references`, or the
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
