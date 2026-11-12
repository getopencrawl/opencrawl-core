# Captured session tokens

The Sessions table shows text size using the portable `o200k_base` tokenizer.
It counts captured message text and tool names, inputs and results, including
imported history. Model input/output usage, billing periods, transport metadata,
Codex prompt echoes, compaction snapshots, hidden reasoning and binary attachments
do not contribute. This is a stable cross-agent size measure, not an assertion
about each model's own tokenizer or context window.

Indexing writes `capturedTokens` on each event's first passage only. Existing
event identities deduplicate retries and captures from multiple installations.
The list aggregates all events in each authorized session, even when only one
message matched the search. If any event lacks a count, the total is unavailable;
zero is a measured empty total. The frontend abbreviates counts and exposes the
unrounded number in its tooltip and accessible label.

## Historical counts

After deploying the new API and indexer, use the exported
`migrateSessionTokens` operation from `sessions/token-migration`. Provide the
deployment's tenant-bound realm, trusted principal, object store and capture
prefix. It defaults to a dry run, 100 events per page and 1,000 per segment;
explicit `dryRun: false` applies the additive metadata patch. Save `after` from
`onPage` and resume it after interrupted or bounded segments. Use one operator
per tenant. It rechecks original ownership, preserves privacy, acquires the
session deletion fence, verifies readback and cannot recreate deleted documents.
Source text, passage boundaries, raw captures, ingestion receipts and billing
remain unchanged. Cached batches contain only bounded event IDs and numbers.

Run a small dry run and applied canary first. Compare an original transcript's
count with the displayed total, then process bounded segments while monitoring
search/API health. After completion refresh the realm and verify zero first
passages without `capturedTokens`; reconcile any skipped deleted sessions with
their deletion status. Errors stop the segment instead of reporting partial
counts. A retry fills only missing metadata. Run the same procedure for each
existing tenant; new captures already receive counts through normal indexing.

Rollback uses the previous API/worker release, which ignores the additive field.
No content restoration or deletion rollback is needed. If older writers accept
new events during rollback, rerun the missing-count backfill after upgrading.
