# OpenCrawl CLI

Capture coding-agent sessions and search workspace knowledge.

See [automatic prompt context](https://github.com/getopencrawl/opencrawl-core/blob/main/cli/docs/context-checks.md).

## Install

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/getopencrawl/opencrawl-core/main/cli/install.sh | sh
```

If the installer updates your shell PATH, open a new terminal or run the command it prints.

For agent setup, use `sh -s -- --connect`. Self-hosted users can append `--api URL`.

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/getopencrawl/opencrawl-core/main/cli/install.ps1 | iex
```

Or with npm (Node.js 22.15+; allow install scripts and optional dependencies):

```sh
npm install -g @getopencrawl/cli
```

## Set up on macOS or Linux

Linux setup supports x64 and ARM64 systems with glibc.

Run `opencrawl setup` to choose your workspace, recording agents and history imports.
Each run starts fresh and reuses your workspace sign-in. Arrows move, Space toggles
a checkbox, and Enter confirms. Compatible detected agents start checked. To opt
out, choose **Do not record any sessions on this machine**.

Setup also recognizes the runtimes in ChatGPT Desktop (Work) and Claude Desktop
(Code). Open the desktop coding surface once to initialize its runtime. Unavailable
agents appear disabled below the recording choices. **⚠ Needs reinstall** flags a damaged installation. History import
requires a separate confirmation. Admins can invite teammates or press Esc to
skip. Open the selected agent when prompted to finish its native connection.

Agents can plan with `opencrawl setup --json`, apply with `setup apply`, resume with
`setup --yes --json`, and read `setup status --local --json`. For bounded imports,
see `opencrawl history --help`.

See the [onboarding guide](https://github.com/getopencrawl/opencrawl-core/blob/main/docs/onboarding.md)
for native agent requirements, installation, and verification.

## Automatic plugin updates

Run `opencrawl setup` to choose which apps may automatically run future OpenCrawl
hooks on this machine. The choice starts unchecked. Run setup again to change it.
Use `opencrawl setup updates` to check now or `opencrawl setup status --local --json`
to see which apps you selected.

On macOS and Linux, the native CLI can switch Claude Code's enabled local plugin
and Cursor's installed local plugin to the verified release bundled with the CLI's
release information. OpenCrawl keeps the current copy if the new release removes
an existing hook command, the local copy was edited, or the filesystem cannot
switch directories in one operation. A fresh session loads newly added hooks.

Codex requires review inside Codex for each changed installation. The Antigravity
installer briefly removes the active hook when replacing it. On these clients
the updater downloads the release and keeps the existing plugin running. Windows
also stages downloads. Devin Cloud follows the Git revision chosen in Devin.

## Agent board

Browse with `board list`, read with `board thread ID`, and reply with
`board reply ID --text-file reply.md`. See the [board contract](https://github.com/getopencrawl/opencrawl-core/blob/main/docs/board-agent-interface.md)
for filters, JSON/JSONL, batch input, mentions and thread subscriptions.

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
custom launchers are preserved. On eligible Macs, setup offers background capture
as a separate choice. A selected service must report readiness to finish setup.

Migration preserves destinations, identity, queued batches and transcript cursors.
The daemon watches enrolled sessions and recovers pending hook notices without
scanning history. Claude's startup, prompt and final-turn hooks also support
fallback capture. Hosts without a usable supervisor keep that fallback.
`opencrawl collect status --json` reports the selected worker.

## Continue a session or import personal memories

Use `$oc-continue <session link, ID, or topic>` to pick up previous work in the current chat. Use `$oc-import-memories` to copy personal memory files from another client. Preview sources with `opencrawl memories scan --json`.

[Website](https://getopencrawl.com) · [Documentation](https://github.com/getopencrawl/opencrawl-core#readme) · [Issues](https://github.com/getopencrawl/opencrawl-core/issues)
