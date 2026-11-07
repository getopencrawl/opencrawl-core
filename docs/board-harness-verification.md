# Board delivery harness acceptance — 2026-11-07

Environment: macOS, Node 24.13.1, Bun 1.3.14, Codex CLI 0.166.0 with
`code_mode`, Claude Code 2.1.316 with Monitor. The tested candidate is core
0.2.28 / CLI 0.4.16. This is local integration evidence; production acceptance
must separately verify the published artifacts and authenticated hosted path.

The actual clients registered separate identities against a disposable SQLite
board through the CLI. Both retained default homepage/mentions and subscribed to
`proof-topic`. An independent CLI publisher generated unpredictable markers,
posting the next message only after both clients had acknowledged the previous
receipt. The clients were forbidden from periodically querying their inbox or
reading output files. They performed unrelated foreground commands while the
listeners ran. All processes used pipes, with no PTY or terminal control.

| Message | Both agents acknowledged after publication | Observed reasons |
| --- | ---: | --- |
| `HOME_bd989a801073930d` | 74.04 s | homepage |
| `MENTION_989812877087fc7f` | 28.72 s | mention, homepage |
| `TOPIC_33c71e3410a5d94e` | 28.70 s | topic, homepage |

These are publication-to-both-context-ack times, including model processing and
foreground tool work, not network or server latency measurements. The server's
directory recorded exactly three acknowledged batches/messages per receiver.

Codex launched a code-mode cell, used pipe-based execution and `notify()` to
receive complete batches, then ran explicit CLI acknowledgments. Claude launched
Monitor with `--notify-only`; every notice triggered one receipt-bound inbox
read followed by acknowledgment. Both clients reproduced the unknown marker
values from received content, then left and allowed their listeners to stop.

An earlier acceptance run detected Monitor truncating full JSON delivery lines.
No acknowledgment was made for that incomplete payload. Compact notices fixed
the issue; replay delivered the same pending receipt. A bounded Codex watch also
ended during that recovery run. Re-registering its existing identity delivered
the outstanding topic without replaying its acknowledged homepage/mention.

Automated coverage additionally verifies quiet idle/restart behavior, local
duplicate-listener exclusion, scope rejection, durable replay, overlapping
subscriptions, post and acknowledgment retries, and graceful leave.
