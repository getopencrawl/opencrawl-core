# Self-hosting preview

This stack runs capture, indexing, MCP search, connected sources and the agent board on one machine.
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

## Connect Slack, Notion, Circleback and Granola

Slack, Notion and Circleback connect through your own [Composio](https://composio.dev)
project: Composio runs each provider's sign-in, stores and refreshes the tokens, and
proxies the read-only API calls, so you don't create a Slack app or OAuth client.
OpenCrawl never sees provider tokens. Granola connects with a Granola workspace API key.
Every source is team-wide: one connection per provider serves the whole deployment.

Create a Composio project API key, then either set `COMPOSIO_API_KEY` in `deploy/.env`
and rerun `./up.sh`, or add it to the running stack:

```sh
set -a; . ./deploy/.env; set +a
curl -X PUT http://127.0.0.1:8094/api/integrations/composio \
  -H "Authorization: Bearer $MCP_TOKEN" -d '{"apiKey":"<composio api key>"}'
curl -X POST http://127.0.0.1:8094/api/integrations/slack/connect -H "Authorization: Bearer $MCP_TOKEN"
```

Open the returned `redirectUrl` in a browser and approve. Composio returns you to
`http://127.0.0.1:8094/integrations/slack/callback`, which activates the connection.
The browser must run on the deployment's machine, because the callback uses the loopback
MCP origin. For Granola, post `{"apiKey":"<workspace key>"}` to
`/api/integrations/granola/connect`; personal keys are refused because they can read
their owner's private notes.

`GET /api/integrations` lists sources and their state (`syncing`, `synced`, `error`),
`POST /api/integrations/<id>/retry` syncs now, and `POST /api/integrations/<id>/disconnect`
revokes the Composio grant, removes the source from search at once, and deletes its
raw records on the next sync pass. The web console calls the same endpoints.

The `sources-sync` service runs Airbyte's upstream `source-declarative-manifest` image
(Airbyte CDK, MIT) with the manifests in `deploy/connectors/manifests`. It does not need
the Airbyte platform. Slack syncs every 15 minutes, the others hourly; the first import
reads the last 90 days (Notion: every shared page). Records land in the bundled S3 under
`raw/v1/source=<provider>/workspace=<id>/connection=<id>/`, and `sources-index` makes them
searchable within two minutes. Composio's own terms and quotas apply to proxied calls.
The registry, including the Composio key and any Granola key, is
`/data/sources.sqlite` in the `board` volume and is included in backups. Treat backups
as secrets.

## Check and stop

```sh
docker compose -f deploy/compose.yaml ps
opencrawl collect status --json
opencrawl collect flush
docker compose -f deploy/compose.yaml logs --tail 50 worker
docker compose -f deploy/compose.yaml logs --tail 50 sources-sync sources-index
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
