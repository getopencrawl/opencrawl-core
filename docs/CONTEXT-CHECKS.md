# Bounded context suggestions

`POST /api/context/suggestions` accepts the same authenticated agent credentials as
workspace search. Upload-only credentials cannot read context. Browser-origin
requests are rejected. The self-hosted runtime exposes a working local lexical
judgment adapter; it needs no model vendor, OpenCrawl account or telemetry.

```json
{
  "eventId": "native-turn-id",
  "currentSession": {"harness": "codex", "sessionId": "native-chat-id"},
  "role": "user",
  "message": "Diagnose the queue retry timeout",
  "task": "Restore reliable background indexing",
  "context": [{"role": "assistant", "text": "The worker restarts during retries."}]
}
```

The response is `{schemaVersion: 1, data: ...}`. Data contains `policyVersion`,
`results`, `searched`, `candidates`, `partial`, and `outputTokens`. Each result
contains its existing workspace search ID, source, title, exact quoted text,
UTF-16 offset, provenance and score. These are historical leads, not authority or
proof that a claim remains true. Scores are adapter-specific, not calibrated
probabilities that a coding task will succeed. No results is a successful check;
authentication, budget, provider and transport failures remain explicit errors.

Core bounds one check to 12,000 input bytes, three workspace searches, 24 retained
candidates, 12 ranked candidates, five returned quotations, and 1,600 o200k output
tokens including result metadata. Each candidate contributes at most 1,600 UTF-8
bytes and each quote at most 200 tokens. The runtime supplies authorization and
enforces the 20-second operation deadline. Work that ignores cancellation cannot
start another stage after the deadline. Runtime search adapters must retain their
own network deadlines. Source fetches recheck access and exact quotation content;
membership is checked again before disclosure. Current-chat sources, future
session events, tool roles and repeated text are excluded.

`@getopencrawl/opencrawl-core/search/check` exports the schema, limits, operation
and `CheckJudgment` contract. Adapters provide `plan`, `shortlist` and `rank`;
each is invoked at most once. They must bound any provider calls internally.
`search/check-http` exposes the common HTTP transport. Hosted deployments may
decorate this operation with commercial admission, durable idempotency, private
judgment and optional tracing. Core does not require those services.

This is a bounded candidate search, not an exhaustive recall guarantee. Caller
timestamps limit evidence age; they do not prove when documents became searchable.
The caller must supply the actual native chat identity and a stable event ID when
its harness provides one. Reuse an event ID and identical input when retrying.
Harness-specific asynchronous delivery is a separate transport concern; an HTTP
success does not establish that a harness injected the returned context.

For a working self-host judgment extension and lifecycle telemetry, see
[Context suggestions](CONTEXT-SUGGESTIONS.md).
