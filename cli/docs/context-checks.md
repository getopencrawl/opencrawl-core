# Context suggestions

Claude Code, Codex, Antigravity and Cursor can suggest related work from your workspace. Suggestions are on by default when you choose an agent to record new sessions. After installing and trusting the plugin, start a fresh session. An eligible check sends a redacted prompt and bounded recent prompt context to your workspace and returns relevant excerpts when available.

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

| Guided setup agent | When the plugin checks and delivers suggestions |
| --- | --- |
| Claude Code | The async user-prompt hook returns workspace context at a native delivery point. |
| Codex | The async user-prompt hook returns workspace context at a native delivery point. |
| Antigravity | Before a model invocation, the hook matches the latest explicit human input in the session transcript and can return transient context. |
| Cursor | Plugin 0.3.6 can return context at prompt submission on Desktop 3.18.9+ and interactive CLI builds dated 2026.11.22 or later. On older hosts, a tool completion or failure in the same generation triggers the check. |

The Cursor CLI can omit the submit event. In interactive build 2026.11.22-e9042b2, a plugin alone does not trigger it. A user or project submit hook must already exist. Without a prompt event, or with plugins through 0.3.5, use manual workspace search. Standard
guided setup offers the four local agents on macOS and supported Linux systems.
For Devin's separate installation and member-authenticated suggestions, see
the [Devin plugin](https://github.com/getopencrawl/opencrawl-plugins/tree/main/plugins/devin).
Grok Bot has no automatic prompt-context adapter.

## Bounds and account safety

The local plugins use native session and prompt IDs to deduplicate requests.
They skip missing IDs, private sessions and excluded projects. Saved preferences
can enable or disable suggestions independently of recording. The plugin checks
the installation, account and workspace before sending the request and again
before releasing a result.

The request includes at most 4,000 characters of redacted prompt text, 1,000
from the original task, and four preceding human prompts of up to 400 characters
each. The service applies its own request, search and output limits. Older or
superseded checks expire. Each result identifies the historical source.

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
