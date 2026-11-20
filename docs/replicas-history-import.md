# Direct Replicas history import

In **Integrations → Replicas → Connect**, an OpenCrawl admin enters an organization API key from **Replicas Settings → API Keys**. OpenCrawl verifies the organization identity and inventory, then confirms the connection once Temporal accepts the job. The worker checks each chat independently. A temporary inventory failure schedules a background retry with the verified key. An empty inventory completes immediately.

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
The importer fingerprints each full catalog record and checks native chat revisions.
After the initial import, the same Temporal workflow sleeps until the next daily
scan. It reads the organization catalog and stale workspace chat lists once per
pass. Unchanged chats require no history downloads or indexing handoffs.
A new catalog record or a newer native revision queues that chat. Replicas pages
history backwards and supplies no immutable-prefix guarantee, so a changed chat
is checked through its terminal cursor. Active page continuations and transient
failures resume from their checkpoints between daily scans.

### Live capture and history of the same chat

OpenCrawl links a historical chat to a Claude Code or Codex capture when the
Replicas history establishes the same native provider and thread UUID. Conflicting
thread IDs or multiple historical chats claiming the same thread leave the
captures separate. Previously imported history is checked once against the
stored archives. This recovery does not call Replicas or reindex transcripts.

The session list groups matching recordings visible to the reader. The live
transcript and the Replicas history each keep their original permissions and
direct links, including events available from just one source. Workspace search
groups matching messages using their role, a SHA-256 digest of the full
structured message content and native event identity. An event without a
native ID requires an unambiguous exact timestamp within the verified thread.
Multi-passage matches also require the same passage text. Callers can inspect
individual occurrences with `dedupe: false, groupBy: "none"`.

When a history request fails for one chat, the worker stores the catalog record, exact cursor and occurrence counters in PostgreSQL and continues the inventory. Deferred records become eligible after one minute with exponential backoff capped at six hours. While new catalog work remains, the worker checks for a due retry after four foreground steps. It advances one deferred page and then returns to the foreground checkpoint. Once the foreground scan finishes, all activity capacity goes to deferred pages. Duplicate catalog entries that receive the same history-page 404 share a backoff for that workspace, chat, cursor and page size. Each entry retains its own catalog metadata and completes its own ingest. The console shows the import state and counts each saved session once. Retry details remain in the operator diagnostics. The import remains incomplete until every catalog record finishes. Oversized pages retry with smaller page limits. At a limit of one, the importer accepts a response of up to 64 MiB. Oversized individual records are stored losslessly in content-addressed, session-scoped attachment parts. Indexing and authorized transcript reads verify and reconstruct them. Rate limits honor Retry-After up to one day. Network, catalog and storage outages retry the same checkpoint using durable Temporal timers. A worker restart or a closed browser does not require a key.

A 401 or 403 triggers a check of the key's organization identity. A 401 from the identity endpoint or a mismatched organization identity requires a new key. A temporary identity outage or a 403 from that check retains the credential for retry. Access to an individual workspace can depend on Team workspace visibility. A 404 alone cannot establish that setting. An admin can stop an active import in Integrations. The daily sync retains the encrypted key while connected. A confirmed credential rejection or an explicit stop clears it. Reconnecting the same organization continues the saved import, including records deferred before the stop. An earlier release may already have erased a key after a failure. Those imports need one reconnect.

Daily catalog diagnostics record examined, unchanged and queued rows. Archive
recovery logs record scanned bytes and page counts, and distinguish a verified
thread from conflicting evidence. Both operations checkpoint per tenant and import.

### Diagnosing a stalled import

Look up the Temporal workflow `replicas-history-<import ID>`. Its activity results and timers show when the next attempt is due. Search worker logs for `replicas.import.issue`, `replicas.import.recovered`, and `replicas.import.activity_retry` with that import ID. The receiver logs `replicas.import.connect_failed` for rejected provider requests during setup.

For a durable record, read `state->'recentIssues'` in `opencrawl_replicas_imports` for the exact namespace and tenant. It contains the most recent 32 decisions. Each outstanding record in `opencrawl_replicas_deferred` also stores its latest issue and retry time. Diagnostics include operation, status when available, validated provider request ID, workspace and chat IDs, cursor hash, page limit, elapsed time, attempt, decision and retry time. After repeated history 404s, a bounded read of the same workspace’s chat list records whether the requested ID appears there. The check runs at most once per day after a successful workspace observation. Failed observations remain retryable. The diagnostic export sample is limited to 32 workspaces per half hour. A waking response retries the saved page. An empty first and final page is deferred if the provider reports any messages. An explicitly null thread with no messages must also exist in the workspace chat list before it can count as a genuinely empty chat. Provider bodies, keys, raw cursors and chat contents are excluded from diagnostics and Temporal history.

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
