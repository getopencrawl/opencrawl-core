# Direct Replicas history import

In **Integrations → Replicas → Connect**, an OpenCrawl admin enters an organization API key from **Replicas Settings → API Keys**. Enable **Team workspace visibility** under **Settings → Preferences** so the key can read team history. OpenCrawl checks the identity, inventory and read access, then confirms the connection once Temporal accepts the job. An empty inventory completes immediately.

## Complete retained session history

Every exported conversation is imported as organization history, regardless of
agent or workspace owner. There is no personal-session mode, provider allowlist,
text-only filter or empty-chat skip. The import preserves:

- Every original history event, including user and assistant messages,
  intermediate updates, tool calls and results, reasoning, system and lifecycle
  events, usage metadata, and unknown event types.
- The entire original response for every history page, including native Codex
  transcript turns, sender information, goals, cursors, attachment payloads and
  references, and fields added by Replicas in the future.
- Repeated identical source events, even when they have no native event ID.

Preservation is lossless for the JSON returned by the Replicas history API.
Separate external files that the response only references are not downloaded;
the references and any embedded data are preserved exactly. Deleted or expired
history that Replicas does not return cannot be recovered by this connector.

Every session uses the `replicas` capture namespace. The original provider and
native IDs remain attached to its records. Read projections make messages and
tool activity readable without rewriting source records. The session read API
includes original records in `raw`; the transcript exposes full original history
pages under **Original Replicas record**. Tool-result display previews may be
clipped by the shared transcript UI; the original record is retained in full.
Search indexes the retained event text, including long tool output, through the
normal session pipeline. Existing agent-search preferences still apply:
`includeToolOutputs: true` includes tool-result passages. These search controls
never remove captured data.

## Pagination, checkpoints and credentials

The importer uses GET requests to `https://api.replicas.dev`, pins API version
`2026-10-07`, and refuses redirects. It pages `/v1/organization/conversations`
and `/v1/replica/{id}/history`. Sleeping and archived workspaces are not woken.

Each background activity processes one complete history page. The original page and all of
its events/turns go through immutable session ingest and durable indexing
handoff. Large pages are split across ingest batches without truncating records.
PostgreSQL commits the cursor and occurrence counters only after all batches
are accepted. Failed partial handoffs retry the same IDs and immutable paths.
Replicas can repeat a chat ID with different catalog metadata. The importer
preserves those catalog records while counting distinct sessions separately.
Repeated imports of unchanged history do not duplicate records. Native live
captures use a separate identity and can overlap with historical imports.

Unknown event/provider formats are preserved. Missing access, absent retained
history, invalid/repeated cursors, oversized responses and transient failures
pause the import without skipping the conversation or reporting completion.
An organization key must be able to read every exported workspace. Replicas may
require **Team workspace visibility** for that access; the importer does not
change organization settings. Fix access and resume the same checkpoint.

The Temporal worker continues independently of the browser. PostgreSQL checkpoints each page. Retryable failures back off automatically. After a terminal failure, an admin can reconnect the same Replicas organization to continue at the saved page. Credentials are encrypted with AES-256-GCM and are erased on completion or terminal failure. Temporal receives the tenant and import IDs. The hosted receiver and worker use a dedicated encryption secret.

For human messages, OpenCrawl matches the native or Replicas message ID to sender records in the organization catalog and history page. The transcript and participant filter use the reported display name or email. Ambiguous or missing evidence leaves a message unattributed.

## Branch verification

`tools/replicas-import-preview.mts` is a loopback-only disposable fixture using
real local authentication, a local Temporal worker and synchronous SQLite indexing. It requires a test
PostgreSQL URL, `REPLICAS_PREVIEW_ROOT=/private/tmp/replicas-backfill-…` and the
exact authorized `REPLICAS_PREVIEW_ORGANIZATION_ID`. Never deploy this fixture.
Verification compares fetched pages with stored raw responses, source event
counts and readback, tool-output search, replay, and workspace lifecycle state.
Revoke the test key, restore temporary organization settings, and remove the
fixture data after verification.

References: [organization export](https://docs.replicas.dev/api-reference/replica/list-organization-conversations),
[history pagination](https://docs.replicas.dev/api-reference/replica/read-history),
[API access](https://docs.replicas.dev/features/api#access).
