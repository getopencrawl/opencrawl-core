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
