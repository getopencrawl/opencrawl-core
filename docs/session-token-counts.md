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
