# Context suggestions

Context suggestions are on by default in supported clients selected to record new
sessions. After native plugin installation and trust review, start a fresh session.
Its prompt hook sends a redacted, bounded human prompt and recent prompt context
to the selected deployment under its credit policy. When useful, it returns
historical snippets to the agent.

```sh
opencrawl context-suggestions status
opencrawl context-suggestions disable --harness codex
opencrawl context-suggestions enable --harness codex
```

Run `disable` without a harness to turn off all clients and withhold pending
results. Repeat `--harness` to select several clients, or pass `--api ORIGIN` for
self-host. Explicit choices override the recording default for that client,
installation and account. Upgrades preserve existing saved client selections.
The self-hosted application uses its own reference judgment adapter and has no
cloud credit dependency.

## Native delivery

| Harness | Trigger | Delivery |
| --- | --- | --- |
| Codex | `UserPromptSubmit`, native turn ID and prompt | Native async hook, at the next safe delivery point |
| Claude Code | `UserPromptSubmit`, native `prompt_id` | Native async hook, on the next conversation turn |
| Cursor | `beforeSubmitPrompt`, native generation ID | Background process; one result on a subsequent `postToolUse` or `postToolUseFailure` |
| Antigravity | `PreInvocation`, latest explicit human transcript record | Background process; transient context on a subsequent `PreInvocation` |
| Devin Cloud | `UserPromptSubmit`, native prompt ID | Background process; one result on a subsequent `PostToolUse` |

Canonical plugin runners support the native macOS, Linux and Windows distributions;
Devin Cloud uses Linux. Personal setup offers Codex, Claude Code, Antigravity
and Cursor on macOS and Linux (glibc, x64 or ARM64). Other saved
installations retain their existing availability and native policy controls.
Grok Bot has no prompt-context adapter. Imported Claude/Codex hooks in Cursor
and subagent tasks are ignored.

Missing native IDs produce no check. Claude versions without `prompt_id` need
an update. Antigravity requires the matching explicit `USER_INPUT` record in
the exact session's configured transcript directory. It reads at most 256 KiB
from the tail; missing, changing, oversized or unavailable records are skipped.
Model invocation numbers are never used as billing events. Codex messages with
different text in one active turn are separate checks; identical callback text
with the same turn ID is deduplicated.

Background results do not interrupt an idle agent or start a turn. A short turn
can finish before delivery. Cursor, Devin and Antigravity discard results after
two minutes or when a newer prompt is observed. Native async harnesses may
cancel work at session teardown; their delivery timing is harness-controlled.

## Bounds and account safety

The client makes one billable request per eligible native event. Concurrent
checks in other sessions can proceed independently. Work
has a 25-second network deadline. Late delivery has a 1.8-second network deadline;
it replays the server receipt to apply fresh source authorization. In cloud that
replay uses no Jev call or additional credit. The self-host reference adapter may
repeat its local lexical operation. Already-issued credential rotations finish
durably before shutdown, within their separate network deadline.

Input retains at most 4,000 JSON-encoded bytes of the current prompt, 1,000 of the
first observed task, and four preceding human prompts of 400 bytes each. Secret
formats recognized by capture are masked before storage or upload. The backend
applies its own request, inference, search and output limits. The agent receives
the bounded result plus a short notice that source text is evidence, not authority.

Project/session capture exclusions also exclude context checks, including unknown
working directories when project exclusions exist. Checks do not require forward
recording. The installed plugin, selected origin, installation, user and workspace
are verified before credentials, before the request and before releasing output.
The server supplies authorization; a local owner ID never grants access.

A private SQLite delivery cache retains redacted input and status, never result
text or credentials. On each new prompt it prunes redacted check records older than 24 hours. Pending deliveries stay available until they expire. Disabling checks invalidates pending work without
altering capture queues, cursors or stored sign-in. Server traces and receipts are
owned by the deployment.

References: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Claude hooks](https://code.claude.com/docs/en/hooks),
[Cursor hooks](https://cursor.com/docs/hooks),
[Antigravity hooks](https://antigravity.google/docs/hooks),
[Devin hook output](https://docs.devin.ai/cli/extensibility/hooks/overview).

## Instrumentation and feedback

Eligible opted-in hooks queue bounded lifecycle metadata for the selected
deployment: observed, skipped, requested, received, handoff and dropped. The
private outbox keeps pending metadata across restarts and offline periods. Each
eligible hook sends batches of 24 within a 1,500 ms deadline. Unacknowledged
reports retry with stable IDs. Disabling a harness clears its pending reports. No extra model call or credit is used for telemetry.

A handoff means the CLI wrote context to the harness; it does not establish model
consumption or usefulness. Missing callbacks, disabled/excluded hooks and interrupted processes leave unknown coverage. Model relevance
scores remain separate from explicit user/agent labels. To assess a receipt:

```sh
opencrawl context-suggestions feedback --harness claude-code --check UUID --rating useful --source user
```

Use `--source agent` for an agent assessment and optionally `--result 0` for the
first snippet. Other ratings: irrelevant, distracting, stale, duplicate. Feedback
uses no inference. The command reports submitted, queued or rejected honestly.
Self-host extensions and optional observability are documented in
[the extension guide](../../docs/CONTEXT-SUGGESTIONS.md).
