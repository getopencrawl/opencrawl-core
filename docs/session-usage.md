# Main session overlap

Usage shows the daily time-weighted average and peak number of overlapping main
sessions over its report window (30 days by default). Days use UTC, matching the
existing Usage activity chart. The current day's denominator is elapsed time,
not a full 24 hours, and its label says partial.

A session's span is `[first captured event timestamp, last captured event timestamp)`.
Idle gaps and later resumptions count. This is captured-session overlap, not CPU
utilization or proof that a process remained alive. A last event is an observation,
not a completion signal. New captures and historical imports can revise past days.

Identity is `(owner, harness, native session ID)` across installations. Any indexed
subagent origin excludes that entire session. Missing origin remains main; main
does not imply human-initiated. Zero-duration sessions add no overlap. Native
event timestamps are required; upload times never substitute for them. Passage
chunks beyond zero are ignored. Both event and receipt times are bounded by the
measurement cutoff. All event kinds and imported history are included.

`src/sessions/overlap.mts` enumerates key-ordered session groups through the shared
realm adapter, retaining whole-history bounds before clipping to the display
window. An exact endpoint sweep computes peaks and the integral divided by each
day's elapsed milliseconds. Coincident starts/ends are grouped; intervals ending
at midnight do not contribute to the next day.

The query uses the verified principal's tenant, indexed visibility filtering,
and fresh authoritative owner controls before releasing aggregates. Deleted and
other owners' private sessions are excluded even if the projection is stale.
Upload-only principals cannot read. The browser receives daily numbers only.
OpenSearch and the operator-owned SQLite adapter exercise the same operation.

Reads are bounded to 25 pages of 2,000 session groups, a two-second query timeout,
and an eight-second scan budget checked between pages. Inexact counts, failed
shards, timeouts, cursor repetition, changing remaining counts, missing identity
coverage and exhausted limits fail the chart as unavailable. No partial series
is shown as complete, and the other Usage sections remain available. A visible
Usage page retries through its existing one-minute refresh cycle. No schema
migration or persistent data writes are introduced; rollback is a core pin rollback.

## OpenCrawl calls and search history

Usage counts authenticated MCP tool invocations and agent HTTP operations, including
board participation, setup, capture, retrieval and context checks. Aliases and
HTTP retries each represent one incoming call. Protocol discovery, browser
console reads and unauthenticated traffic are excluded. The captured-session and
alignment reports continue to use their own data and measurement windows.

The two search histories are ordered by server time and ID, newest first. A
proactive row is one check that actually executed a search, with the queries it
ran and the triggering message ID and preview. Non-silent counts checks that
returned suggestions. Confirmed handoffs count distinct checks whose client
reported writing a suggestion into context. A replay creates no additional
proactive search. A check that stopped before searching has no search-history row.

Workspace totals use daily PostgreSQL counters. Detail pages use bounded keyset
reads. The server rechecks current session visibility before disclosing rows,
including visibility changes awaiting search indexing. Unlinked searches and
sessions without a verifiable capture are visible only to their owner. Session
deletion removes associated history and fences late writes. Query text and
message previews stay in the application database and are excluded from external
analytics. The visibility window is 30 UTC calendar days. Older detail rows are
pruned in bounded batches. Rollback can retain the additive tables.

A deployment with earlier completed check receipts may import their recorded
outcomes into the rolling window. Receipts without a source session, message or
query show those fields as unavailable. They do not increment the newer call
counter. Reimporting the same receipt does not change the totals.

A deployment can also restore authenticated tool calls recorded before detailed
tracking began. The importer accepts stable source receipt IDs, server timestamps,
owners and an optional search operation. It deduplicates within each workspace
and accepts only the pre-tracking portion of the visible window. Search details
from these records are visible only to their owner. The report identifies missing
queries, sessions and outcomes, and distinguishes earlier calls from full tracking.
