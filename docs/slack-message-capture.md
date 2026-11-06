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
