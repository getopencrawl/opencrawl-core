# opencrawl

The OpenCrawl CLI. This initial release installs an automatically updating
command and signs you in. **Index queries are not available yet.**

Once published:

```sh
npm install -g @getopencrawl/cli@next
opencrawl login
opencrawl status --json
```

For SSH, remote machines and coding agents:

```sh
opencrawl login --no-browser --json
```

Open the printed URL on any machine, confirm the displayed code and sign in.
The CLI waits for approval. It needs no client secret, inbound port, localhost
callback or browser on the machine running the command. No authentication runs
during package installation. Installation does not configure agents or telemetry.

`whoami` verifies your identity with the service. `status` reports the version,
sign-in state and unavailable index. `logout` removes this deployment's local
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

`--json` returns `{schemaVersion:1,data:...}` or
`{schemaVersion:1,error:{code,message}}`. Progress and approval instructions stay
on stderr. Exit codes: 0 success, 1 service/network failure, 2 sign-in required
or forbidden, 64 invalid arguments, 130 interrupted.

## Updates and distribution

TypeScript compiled with Bun 1.3.14 produces a self-contained binary. Users need
Node 22+ and npm for the bootstrap, never Bun. npm platform packages cover macOS
arm64/x64, Linux glibc arm64/x64 and Windows x64. Alpine/musl and Windows arm64
are not supported in v0. Platform packages are optional dependencies at the exact
launcher version; there are no install scripts.

After a command, the launcher starts a detached updater at most once per day.
It checks the npm `next` release channel, installs into a private user-owned cache with
npm integrity verification and install scripts disabled, then atomically selects
the complete release. The next invocation uses it. No sudo or global-directory
writes are needed. Offline/update failures preserve the working copy and retry
after 15 minutes. Concurrent updater processes share a lock; updates never
downgrade. An unused installation updates when it is next invoked, not on a timer.

`OPENCRAWL_NO_UPDATE=1` disables automatic updates for reproducible agent runs.
`opencrawl update [--json]` explicitly updates from that same channel. Cached releases live under
`$XDG_CACHE_HOME/opencrawl` (default `~/.cache/opencrawl`); previous releases remain
available for recovery. Install a newer npm version directly to override an older
cached version. Set the opt-out and remove `current.json` to return to the npm
installed version. Standalone binary installation/self-update is not offered in
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
binaries on macOS/Linux/Windows, then publishes the five platform packages first, then publishes `@getopencrawl/cli` last. A failed platform
publication cannot advertise an incomplete stable launcher. Retry skips already
published immutable versions. Increment `cli/package.json` for every release.
The main core package retains its separate private GitHub Packages release.

Create the free npm `getopencrawl` organization and grant the publisher access to
its packages before the first release. Bootstrap publication uses an npm token
or interactive npm authentication; configure npm trusted publishing for each
package afterwards. A public npm package does not require a public GitHub repo,
but its tarballs and binaries are public. Review the package allowlist with
`npm pack --dry-run` before publishing. The current construction license remains
UNLICENSED pending the repository's separate public-license decision.

Prior art: OnePatch's npm/native launcher, device login, automatic refresh and
background upgrades; Glen's small npm entry point for agents.


### Session capture

After signing in, run `opencrawl collect install` to install Claude Code and Codex hooks and the background transcript collector. Review the commands in Codex `/hooks` or desktop Settings > Hooks. The same local configuration covers desktop and terminal sessions.

`opencrawl collect status --json` reports the enrolled identity, queued uploads, last receipt and errors. `collect sync` reconciles active transcripts; `collect flush` retries queued uploads; `collect uninstall` removes OpenCrawl hooks and stops collection while preserving queued data.

Messages, tool arguments/results and attachments are collected with native session IDs and a stable installation ID. System/developer prompts are excluded. The hosted service derives ownership from login. Self-hosted users can supply `OPENCRAWL_SESSIONS_TOKEN` and `--api` for the portable receiver. See [capture architecture and limits](../docs/session-capture.md).

### Optional history import

`collect install` asks terminal users whether to import past Claude Code sessions,
Codex sessions, both, or skip (the default). Desktop coding sessions use the same
native transcript stores. A JSON/noninteractive install returns
`backfill.status=decision_required` with a preview and instructions for the agent
to ask the user. It never assumes consent. `npm install` itself reads no history.

Agents must show the destination and counts, explain that messages, tool
arguments/results and available attachments will leave the machine, and wait for
the user's choice. The setup request alone is not consent to import history.

```sh
opencrawl collect install --backfill skip  # future collection only
opencrawl collect backfill --dry-run --json  # local metadata only; no upload
# Only after the user chooses a source:
opencrawl collect backfill --harness claude-code --yes
opencrawl collect backfill --harness codex --yes
opencrawl collect backfill --harness all --yes
```

During setup, `collect install --backfill claude-code|codex|all` records the
user's explicit choice in the invocation and imports immediately; `--backfill
skip` skips without prompting. `--json` alone never grants approval. Use the
same `--api` as collection enrollment for preview/import.

Preview reports transcript-file counts and on-disk bytes, not unique sessions
or upload size. It scans `CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`)
and `CODEX_HOME/{sessions,archived_sessions}` (default `~/.codex/`). It follows no
transcript symlinks and does not read conversation content. Import includes
subagent transcripts in those directories and only records the harness saved
locally. Cloud-only Claude chats, Cowork VM records, deleted sessions and missing
attachments cannot be recovered by this importer.

A one-time import reuses capture cursors, owner checks, attachment storage and
durable receipts. It does not turn on recurring historical scans. Rerun the
same approved command after an interruption; completed records are skipped.
Failures return nonzero rather than reporting a complete import. Status still
shows queued uploads and errors; `collect flush` retries uploads already queued.
