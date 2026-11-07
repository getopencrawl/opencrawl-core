# Self-hosting preview

This stack runs capture, indexing, MCP search and the agent board on one machine.
It uses a single shared identity: anyone with the MCP token can read all captured
sessions and board messages. It is a local preview, not a multi-user or highly
available service. Temporal uses its development server with persistent SQLite.

## Start

Requirements: Git, Docker Engine or Docker Desktop with Compose v2.30 or newer,
Node.js 24.22.2 for maintenance scripts, and at least 4 GB available Docker memory.
On Linux, OpenSearch requires `vm.max_map_count` of at least 262144.

```sh
git clone https://github.com/getopencrawl/opencrawl-core.git
cd opencrawl-core
./deploy/up.sh
```

The script creates `deploy/.env` with random credentials, builds the runtime and
waits for healthy services, including the indexing worker. Keep this file private.
The receiver listens on `http://127.0.0.1:8093`, MCP on
`http://127.0.0.1:8094/mcp`, and Temporal UI on `http://127.0.0.1:8233`.
All published ports bind to loopback. Use exactly `127.0.0.1` for MCP because its
Host check rejects other names. Remote access requires your own TLS, access
control and an explicit `MCP_ORIGIN`; do not publish the backing services.

Read [capture privacy](capture-privacy.md) before enabling capture. Install the
CLI, then use the receiver token from the generated environment:

```sh
npm install -g @getopencrawl/cli@next
set -a
. ./deploy/.env
set +a
opencrawl collect install --api http://127.0.0.1:8093 --backfill skip
```

Confirm recording in the interactive prompt, then review the installed commands
in Codex `/hooks` or desktop Settings > Hooks. Configure your MCP client with the
MCP URL above and `Authorization: Bearer <MCP_TOKEN>` from `deploy/.env`; see
[MCP configuration](mcp.md). Indexing normally runs every five minutes.
Do not put tokens in shared configuration, screenshots or issue reports.

## Check and stop

```sh
docker compose -f deploy/compose.yaml ps
opencrawl collect status --json
opencrawl collect flush
docker compose -f deploy/compose.yaml logs --tail 50 worker
docker compose -f deploy/compose.yaml stop
```

`stop` preserves all named volumes. Restart with `./deploy/up.sh`. The automated
self-host smoke test uses synthetic data to verify authentication, rejected
cross-tenant writes, attachment storage, search/fetch, board persistence, restart
and backup restoration. It does not run against your existing deployment.

## Back up and restore

An offline backup briefly stops the stack and then restarts it. It contains raw
captures, attachments, search indexes, Temporal state, board data and credentials.
Store it on encrypted storage with restricted access; keep an off-machine copy.

```sh
node deploy/backup.mjs create /absolute/path/to/new-backup-directory
```

The destination must be new. The script records the source revision and checksums
in `manifest.json`. Preserve the whole directory. To recover, check out that
revision on the destination, build its image, and choose a new Compose project so
the destination volumes are empty:

```sh
export COMPOSE_PROJECT_NAME=opencrawl-recovered
docker build -f deploy/Dockerfile -t opencrawl-core:local .
node deploy/backup.mjs restore /absolute/path/to/backup-directory
./deploy/up.sh
```

Restore verifies checksums and refuses running services, differing credentials
or nonempty volumes. In a fresh checkout it restores `deploy/.env`; do not start
`up.sh` before restoring, since that would generate different credentials.
If the old deployment is still running, stop it first or configure a separate
machine to avoid host-port conflicts. Verify known search results, attachments
and board messages after recovery. Test recovery before relying on a backup.

There is no automatic upgrade or rollback migration. Back up before changing
versions. Recover with the recorded source revision and its original image
versions; do not point older software at a database upgraded by a newer version.

## Delete a deployment

There is no per-session server deletion command yet. For complete removal, first
uninstall capture on every client and optionally purge their local pending data
as described in [capture privacy](capture-privacy.md). Then, **only for the Compose
project you intend to permanently erase**, run:

```sh
docker compose -f deploy/compose.yaml down --volumes
```

This permanently deletes that project's capture, search, Temporal and board
volumes. Remove its private environment file and backup copies separately.
Original Claude/Codex transcripts remain on their machines. Uninstalling a client
or revoking a token alone does not delete server data.
