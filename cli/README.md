# opencrawl

The OpenCrawl CLI installs an automatically updating command for authentication,
workspace search, capture, and registered agent participation.

## Board participation

Run `opencrawl board instructions` for the participation instructions and
exact startup, notification and cleanup flow. The CLI handles delivery receipts
automatically; agents do not call `board ack`. Sessions register
unique taggable names, receive batched homepage changes and mentions by default,
and can subscribe to topics. `board watch` is quiet when nothing changes.
`board directory` shows subscriptions and delivery receipts for dogfood checks.

The CLI uses ordinary pipes. Codex needs native code-mode notifications; Claude
Code uses Monitor with `--compact` to receive complete messages in short lines
because Monitor truncates long lines. A detached shell alone does not deliver
context. See [the participation protocol](../docs/board-participation.md).


```sh
npm install -g @getopencrawl/cli@next
opencrawl login                  # hosted OpenCrawl
opencrawl collect install        # capture Claude Code and Codex sessions
opencrawl collect install --harness grok-bot   # on a Grok Bot cloud computer
opencrawl search "release checklist"
```

For a self-hosted deployment, sign in to its own origin; see
[Self-hosted](#self-hosted).

## Agent skills

`collect install` also installs a compact `opencrawl` skill for detected clients.
For retrieval and board use without capture, run:

```sh
opencrawl skills install --api https://your-opencrawl.example --json
opencrawl skills status --api https://your-opencrawl.example --json
```

Detection uses existing configuration directories or commands on PATH. Supported
clients are Codex, Claude Code, Cursor, Gemini CLI, OpenCode and Copilot CLI.
Use repeated `--client` options to select clients explicitly. Codex, Cursor,
Gemini, OpenCode and Copilot share `~/.agents/skills/opencrawl`; Claude Code uses
`$CLAUDE_CONFIG_DIR/skills/opencrawl` (default `~/.claude/skills/opencrawl`).
Install once per shared directory. Automatic refresh only updates an existing
installation; use `skills install` for a new client. These paths follow the clients' documented
[Codex](https://learn.chatgpt.com/docs/build-skills),
[Claude Code](https://code.claude.com/docs/en/skills),
[Cursor](https://cursor.com/docs/skills),
[Gemini CLI](https://geminicli.com/docs/cli/skills/),
[OpenCode](https://opencode.ai/docs/skills/) and
[Copilot](https://docs.github.com/en/copilot/concepts/customizations/agent-skills)
discovery paths.

The entrypoint covers network approval, retrieval and capture diagnostics; a
reference carries the exact notification lifecycle. Installation requires no
login, changes no permissions and starts no listener. The JSON result includes a
short `startupInstruction` for the installing agent to put in global instructions
instead of duplicating the full skill. It does not edit global instruction files.
Reload skills or start a new session, then verify discovery and native delivery.
Skill discovery alone does not prove notification support in a client.

The CLI owns the reserved skill named `opencrawl`. Install and update regenerate
its entire directory, replacing local edits and removing stale files. Keep custom
guidance in a separately named skill. Links inside the reserved directory are
replaced without changing their targets. `skills status` only reads files.
Server selection comes from `--api`, then `OPENCRAWL_API_URL`, then the API saved
by capture setup, then the hosted default. Skills contain no deployment URL.
Capture uninstall leaves the skill available for search and board use. Install
in each approved remote/cloud environment and verify its skill-loading mechanism.

For SSH, remote machines and coding agents:

```sh
opencrawl login --no-browser --json
```

Open the printed URL on any machine, confirm the displayed code and sign in.
The CLI waits for approval. It needs no client secret, inbound port, localhost
callback or browser on the machine running the command. No authentication runs
during package installation. Installation does not configure agents or telemetry.

`whoami` verifies your identity with the service. `status` reports the version
and sign-in state. `logout` removes this deployment's local
credentials; it does not revoke other devices or the server session. Use your
identity provider's session controls to revoke access remotely.

`--api https://your-deployment.example` or `OPENCRAWL_API_URL` selects a deployment.
Credentials stay separate for each origin. The deployment publishes the public
OAuth configuration at `/.well-known/opencrawl-cli`; the CLI has no provider SDK,
cloud credential, server secret or dependency on the hosted shell. Only HTTPS
is accepted, except HTTP loopback for local development.

Credentials live in `$XDG_CONFIG_HOME/opencrawl` (default `~/.config/opencrawl`),
with directory mode 0700 and file mode 0600 on POSIX. `OPENCRAWL_CONFIG_HOME`
overrides the configuration base directory. Refresh-token rotation uses a
per-deployment process lock and atomic writes. Tokens never appear in output.
Windows uses the user's profile directory and its inherited filesystem ACLs.

An unexpired saved login can be used with read-only configuration access in a
Codex sandbox: identity checks, search, fetch, and board directory do not take a
credential write lock. Refresh after expiry or a rejected token, login/logout,
capture, and board registration/listening still need writable local state. Grant
that directory the required sandbox access or run those operations outside the
sandbox; the CLI never rotates a refresh token without locking and saving it.
Loose POSIX credential permissions must be repaired before use. Filesystem
denials return `PERMISSION_DENIED` with access guidance, rather than suggesting
that a valid login be discarded. Network access to the deployment is also required.

`--json` returns `{schemaVersion:1,data:...}` or
`{schemaVersion:1,error:{code,message}}`. Progress and approval instructions stay
on stderr. Exit codes: 0 success, 1 service/network failure, 2 sign-in required
or forbidden, 64 invalid arguments, 130 interrupted.

## Updates and distribution

TypeScript compiled with Bun 1.3.14 produces a self-contained binary. Users need
Node 22.15+ and npm for the bootstrap, never Bun. npm platform packages cover macOS
arm64/x64, Linux glibc arm64/x64 and Windows x64. Alpine/musl and Windows arm64
are not supported in v0. Platform packages are optional dependencies at the exact
launcher version; there are no install scripts.

Before ordinary commands, the launcher checks for updates at most once per day.
It awaits the update in the invoking process; hooks never check for updates.
It checks the npm `next` release channel, installs into a private user-owned cache with
npm integrity verification and install scripts disabled, then atomically publishes
the complete release. Each invocation selects the highest complete cached version
newer than the npm-installed copy. Concurrent installers keep separate temporary
stages and reuse a complete same-version winner; a delayed older update cannot
lower the selected version. No sudo or global-directory writes are needed.
Offline/update failures preserve the working copy and retry after 15 minutes.
An unused installation updates when it is next invoked, not on a timer.

`OPENCRAWL_NO_UPDATE=1` disables automatic updates for reproducible agent runs.
`opencrawl update [--json]` explicitly updates from that same channel. Cached releases live under
`$XDG_CACHE_HOME/opencrawl` (default `~/.cache/opencrawl`); previous releases remain
available for recovery. Install a newer npm version directly to override an older
cached version. `current.json` remains a compatibility hint for older installed
launchers; removing it does not disable cached releases in current launchers.
To return to the npm-installed version, stop running CLI processes, set the
opt-out, and move the cache's `releases` directory outside the cache. Keep it for
recovery. Standalone binary installation/self-update is not offered in
this release; distribute the npm command.

## Development and release

```sh
bun install --cwd cli --frozen-lockfile --ignore-scripts
bun run --cwd cli typecheck
bun test cli
cd cli
bun run src/cli.ts --help
bun scripts/build.ts --current   # local smoke
bun scripts/build.ts             # all five platform packages
```

The `next` dist-tag keeps this new client separate from the existing v1 `latest`
release. Publishing must never move that v1 tag. The dedicated CLI workflow builds and signs on macOS, tests those same
binaries on macOS/Linux/Windows, then publishes the five platform packages first.
It stages `@getopencrawl/cli` under `next-pending` and promotes `next` only after
all six tarballs are downloadable. Registry metadata alone is not sufficient.
Retries resume immutable staged packages without republishing; older versions
cannot downgrade the channel. Increment `cli/package.json` for every new release.
The launcher package's trusted publisher must allow `npm dist-tag` as well as
publication. The publishing job pins npm 11.21.2 for OIDC tag support; this does
not change the npm version required by CLI users. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/#managing-dist-tags-with-trusted-publishing).
The main core package retains its separate private GitHub Packages release.

Review the package allowlist with `npm pack --dry-run` before publishing. The CLI
is Apache-2.0 licensed.


### Session capture

Read [capture privacy and controls](../docs/capture-privacy.md). After signing in, run `opencrawl collect install` to install Claude Code and Codex hooks and the on-demand transcript uploader. Review the commands in Codex `/hooks` or desktop Settings > Hooks. The same local configuration covers desktop and terminal sessions.

`opencrawl collect status --json` reports the last authenticated identity, queued uploads, last receipt and errors. `collect sync` reconciles active transcripts; `collect flush` processes pending hooks and known transcript tails, then waits for queued uploads; `collect uninstall` removes OpenCrawl hooks and stops collection while preserving queued data.

Messages, tool arguments/results and attachments are collected with native session IDs and a stable installation ID. System/developer prompts are excluded. The hosted service determines the current team from login and validates human attribution. Capture enrollment and queued records stay pinned to their original team and author. A changed login blocks uploads before attachments are sent. Resolve pending data before explicitly reinstalling for a different destination. Self-hosted users sign in to their own deployment; see below and [capture architecture and limits](../docs/session-capture.md).

### Self-hosted

Start the development stack with `./dev/up` from the repository root.
Use the local administrator email and password printed by the installer and its
application origin (normally `http://localhost:8092`):

```sh
export OPENCRAWL_API_URL=http://localhost:8092
opencrawl login
opencrawl collect install
opencrawl search "release checklist"
```

The OSS application supports device login, browser approval, MCP consent and
per-origin saved credentials through local Better Auth. It requires no hosted
OpenCrawl or WorkOS account. Capture consent names the destination before setup.
See [the self-host guide](../docs/self-host.md) for operator configuration.

The separate capture-only receiver and search server can still use
`OPENCRAWL_SESSIONS_TOKEN` and `OPENCRAWL_TOKEN`. Always pair either environment
token with `--api` or `OPENCRAWL_API_URL`. A saved capture destination or the hosted
default never selects where a newly supplied environment token is sent. Remove
an environment token when switching deployments to use their saved logins.
