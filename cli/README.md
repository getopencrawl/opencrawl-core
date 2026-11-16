# OpenCrawl CLI

Capture coding-agent sessions and search workspace knowledge.

## Install

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/getopencrawl/opencrawl-core/main/cli/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/getopencrawl/opencrawl-core/main/cli/install.ps1 | iex
```

Or with npm (Node.js 22.15+; allow install scripts and optional dependencies):

```sh
npm install -g @getopencrawl/cli
```

## Set up on macOS

Set up Claude Code, Codex, and Cursor through the CLI:

```sh
opencrawl setup
```

The CLI signs you in, installs the plugins you choose, and asks separately which
past sessions to import. Your agent guides hook trust, MCP sign-in and verification
in the same conversation. History imports run in the background.
Cursor supports its native plugin and new-session recording; its past-session
history is not offered for import.

Use `opencrawl setup status --local --json` to read saved choices and
`opencrawl setup resume` to continue. Setup stays available in the workspace
sidebar and never blocks the rest of the app. Other clients and platforms follow
in a later rollout; existing capture and search commands remain available.

For your own server, add `--api https://your-opencrawl.example`.
See [onboarding](https://github.com/getopencrawl/opencrawl-core/blob/main/docs/onboarding.md) for the complete flow.

## Existing installations and other platforms

```sh
opencrawl login
opencrawl collect install
opencrawl search "release checklist"
opencrawl --help
```

Update with `opencrawl update`.

On macOS and Linux, an eligible invocation of an updated native CLI starts a
background daemon migration for existing enabled capture. The old collector
continues until the supervised daemon reports readiness. If service installation
or startup fails, capture stays on the existing collector and a later invocation
retries. Hooks do not wait for installation or startup. Disabled capture and
custom launchers are preserved. Fresh macOS/Linux plugin setup also waits for
readiness before switching capture. If startup fails, hooks keep using the existing
collector; session context directs the agent to the installed skill for board
registration. `opencrawl setup resume` retries without changing saved choices.

Migration retains the destination, installation identity, queued batches and
transcript cursors. The daemon watches enrolled sessions and recovers pending
hook notices; it does not scan the historical transcript catalogue. Claude uses
three async capture notices: session start, user prompt, and session end. The
per-turn notice repairs a missed initial enrollment without scanning history.
The Claude plugin also has an async final-turn hook so fallback capture uploads
completed answers even when the session stays open. Hosts without
a usable supervisor retain fallback capture rather than reporting an installed
daemon. `opencrawl collect status --json` reports the selected capture worker.

[Website](https://getopencrawl.com) · [Documentation](https://github.com/getopencrawl/opencrawl-core#readme) · [Issues](https://github.com/getopencrawl/opencrawl-core/issues)
