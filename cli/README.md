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
background upgrades; Glen's small npm entry point for agents. No query command,
agent hooks, MCP integration or background daemon is included in this release.


### Session capture

After signing in, run `opencrawl collect install` to install Claude Code and Codex hooks and the background transcript collector. Review the commands in Codex `/hooks` or desktop Settings > Hooks. The same local configuration covers desktop and terminal sessions.

`opencrawl collect status --json` reports the enrolled identity, queued uploads, last receipt and errors. `collect sync` reconciles active transcripts; `collect flush` retries queued uploads; `collect uninstall` removes OpenCrawl hooks and stops collection while preserving queued data.

Messages, tool arguments/results and attachments are collected with native session IDs and a stable installation ID. System/developer prompts are excluded. The hosted service derives ownership from login. Self-hosted users can supply `OPENCRAWL_SESSIONS_TOKEN` and `--api` for the portable receiver. See [capture architecture and limits](../docs/session-capture.md).

### Claude Code cloud

Cloud sessions run on a fresh Linux VM. Local hooks do not transfer. The first
setup prompt should direct hosted users to their deployment's `/capture/cloud`
page, which issues a one-year, revocable, upload-only credential and supplies the
exact setup script. Use a **personal** Claude environment: sessions using that
credential are attributed to its owner, regardless of who starts them.

Keep Limited/Trusted networking and allow the deployment's API hostname plus
npm registries. Add `OPENCRAWL_SESSIONS_TOKEN` in Environment variables and append
the provided script to Setup script. Save and start a fresh session using that
environment. No local Claude installation is required. Human-only settings and
a separate setup session are supported. Environment variables are visible to
commands in that environment; don't paste the credential into the chat or repo.

The installer detects `CLAUDE_CODE_REMOTE=true`, installs Claude hooks only and
skips systemd. `--harness claude-code --no-background` also selects this explicitly.
The setup installs the CLI at
`$HOME/.local/share/opencrawl-cloud/node_modules/.bin/opencrawl`. After a user
message, tool call and image, `collect status` must report a stored receipt and
no error. Don't use manual sync as evidence that automatic hooks work. Search
follows asynchronous indexing, not the upload acknowledgement.

Cloud batches retain the native session UUID and the web session ID from the
native `remote_session_change` attachment, and mark origin `cloud`. Internal
prompt snapshots, environment snapshots and repeated tool/MCP listings are
omitted. Image attachment bytes are stored separately using their digest.

Self-hosted operators use the same protocol: with the configured receiver token,
POST `/api/sessions/credentials` to obtain an upload-only delegation, store the
returned token directly in a private file (not a transcript), then configure the
personal environment above using their HTTPS receiver hostname. DELETE
`/api/sessions/credentials/<id>` with the receiver token revokes it. The child
credential cannot search/read, issue credentials or revoke credentials. The
receiver always binds the operator's fixed tenant/user, including for delegated
tokens. Changing that fixed identity invalidates old delegations.
