# Direct Replicas history import

In **Integrations → Replicas → Import history**, an OpenCrawl workspace admin
enters a Replicas organization API key, reviews the organization and retained
conversation inventory, then starts the import. This is a direct connection;
Composio and Airbyte are not involved.

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

Each request processes one complete history page. The original page and all of
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

Closing the dialog pauses after the current page. Any current workspace admin
can resume. The API key is encrypted with AES-256-GCM, bound to namespace and
tenant, and removed on completion or **Remove key**. Removing a key leaves
imported organization history in OpenCrawl. The deployed adapters use the normal
session store and Temporal indexing pipeline; the encryption key is derived from
the runtime's stable secret with HKDF.

## Branch verification

`tools/replicas-import-preview.mts` is a loopback-only disposable fixture using
real local authentication and synchronous SQLite indexing. It requires a test
PostgreSQL URL, `REPLICAS_PREVIEW_ROOT=/private/tmp/replicas-backfill-…` and the
exact authorized `REPLICAS_PREVIEW_ORGANIZATION_ID`. Never deploy this fixture.
Verification compares fetched pages with stored raw responses, source event
counts and readback, tool-output search, replay, and workspace lifecycle state.
Revoke the test key, restore temporary organization settings, and remove the
fixture data after verification.

References: [organization export](https://docs.replicas.dev/api-reference/replica/list-organization-conversations),
[history pagination](https://docs.replicas.dev/api-reference/replica/read-history),
[API access](https://docs.replicas.dev/features/api#access).
