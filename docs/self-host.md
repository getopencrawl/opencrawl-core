# Self-host OpenCrawl

The Docker Compose deployment runs the full application for one organization with
multiple users. Accounts, sign-in, the CLI and MCP authorization server, search,
and the connector runtime all run inside the stack. It needs no WorkOS, Airbyte or
other external account, and it does not contact an OpenCrawl hosted service.

This branch is a candidate. [Acceptance status](seam-acceptance.md) distinguishes
unit/regression checks from a clean-server install and real provider verification.

## Install

On a Linux server (4 GB RAM or more) or a laptop with Docker Engine and the Compose plugin:

```sh
curl -fsSL https://raw.githubusercontent.com/getopencrawl/opencrawl-core/main/install.sh | sh -s -- opencrawl.example.com
```

Or from a checkout: `./install.sh opencrawl.example.com`. Omit the domain to run at
`http://localhost:8092` on this machine. With a domain, point its DNS at the server
and open ports 80 and 443; bundled Caddy obtains and renews the HTTPS certificate.

The installer writes `deploy/.env` with generated secrets, builds and starts the
stack, and prints a one-time setup link. Open it to create the first admin account
and name the workspace. Running `./deploy/up.sh` again updates the stack in place
and keeps `deploy/.env`. Choose a fresh `COMPOSE_PROJECT_NAME` for each installation
on the same host.

## Accounts and sign-in

Identity uses [Better Auth](https://www.better-auth.com) with its database in the
application volume. The setup link creates the first admin; nobody can register
without it or an invitation. Admins invite teammates from the Team page and share
the displayed link, which is valid for seven days and creates the invitee's account.
The stack sends no email, so possession of the setup or invitation link verifies the
address. Members can be promoted to admin; access is checked against current
membership on every request.

`opencrawl login --api https://YOUR-APP` uses the device flow: the CLI shows a code,
a signed-in member approves it at `/device`, and the CLI receives refreshable tokens.
MCP clients discover `/.well-known/oauth-protected-resource/mcp`, register
dynamically and ask the signed-in member for consent. CLI and MCP access tokens are
short-lived JWTs bound to `https://YOUR-APP/mcp`.

## Connector runtime

The worker runs [Airbyte connector](https://docs.airbyte.com/platform/understanding-airbyte/airbyte-protocol)
images itself; there is no Airbyte platform. On each schedule, it starts the source
image as a sibling container (`discover`, then `read` with saved state), writes
records to the bundled S3 in Airbyte's JSONL layout, and checkpoints state only
after the preceding records are stored. Indexing then proceeds as before. Source
configuration and state are encrypted with `OPENCRAWL_CONNECTOR_KEY`.

The worker mounts the Docker socket to start connector containers. That access is
equivalent to root on the host. The worker exposes no network listener, and
connector containers run with all capabilities dropped and CPU/memory limits. Run
OpenCrawl on a host dedicated to it if that trade-off matters to you.

For existing operator-managed S3/OpenSearch/Temporal services, use a Compose
override to supply their endpoints and credentials to `app` and `worker` and
remove the corresponding local service dependencies. Keep a unique object
prefix and search namespace. The runtime accepts S3-compatible endpoints and
OpenSearch basic authentication; Temporal adapters also accept explicit SDK
connection options.

## Connect sources

Slack uses your own Slack app. Configure user scopes `channels:read`,
`channels:history`, `search:read`, `users:read`, `team:read`, and `emoji:read`; set
its redirect to `https://YOUR-APP/oauth/connectors/slack/callback` (Slack requires
HTTPS). Put its client ID and secret in `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`
in `deploy/.env` and rerun `./deploy/up.sh`. Connect Slack from the app. OAuth grants
are encrypted using `OPENCRAWL_CONNECTOR_KEY`. The connector container gets a
separate revocable capability for that source; it does not get your OAuth client
secret or provider token. Public-channel restrictions apply in the proxy
and indexing pipeline. Token rotation is supported. An interrupted token
exchange with an unknown outcome requires reconnecting that source.

Granola takes a **workspace** API key in the Sources UI; personal API keys are
not supported. GitHub uses your own read-only GitHub App. Its source container is
in `connectors/github/`; `./deploy/up.sh` builds it when `GITHUB_APP` is set. Set `GITHUB_APP` to the base64 JSON bundle described by
`src/integrations/github.mts`: `appId`, `slug`, `clientId`, `clientSecret`, and the
generated PEM `privateKey`. Keep this bundle in the private environment file.
Configure the App's callback URL as
`https://YOUR-APP/integrations/github/callback`, enable **Request user authorization
(OAuth) during installation**, and leave webhooks disabled. Grant read-only
Contents, Issues, Pull requests, Discussions, and Metadata permissions. Install
it only on the repositories you intend to share with this OpenCrawl organization.

Connect starts with GitHub authorization. It reuses an existing installation,
offers an account choice if several are accessible, or offers installation if
none exists. The connector stores a fixed set of repository IDs accessible to
that user. Adding repositories to the GitHub App does not silently add them to
the import; reconnect to confirm a changed selection. Rebuild and update the
source image (rerun `./deploy/up.sh`) when upgrading this connector’s source.

Other shared
provider definitions are available to runtime adapters; this standalone
composition currently offers Slack, Granola, and GitHub.

Sign in, follow onboarding to connect the CLI/MCP client and capture a real
session, then connect a source. Setup completion uses recorded receipts and
current source state. Team admins can invite users and manage roles; ordinary
members can use shared data and keep supported session/memory resources private.
The UI is the same core application consumed by the cloud shell.

## Persistence, deletion, and backup

Named volumes preserve S3 objects, OpenSearch indexes, the application registry,
and Temporal's PostgreSQL data. The registry refuses to reopen under a different
organization. Workers rediscover active connections and captured objects after
restarting; pending connection creation intents are reconciled before any retry.

Disconnect first cancels and removes the connection's connector jobs, revokes the source grant, and
deletes its landed objects. Search denies the disconnected binding immediately.
The worker deletes indexed documents and repeats the purge after in-flight
writes have settled. Session and memory deletion use the shared core lifecycle.

Create an offline backup with:

```sh
node deploy/backup.mjs create /absolute/new-backup-directory
```

The script stops this Compose stack, saves its data volumes and `.env` with
restricted permissions, records checksums and source revision, then restarts it.
The environment includes the encryption key: preserve it alongside the backup.
Accounts, sessions and connector state live in the application volume and are
included.

Restore only at the recorded Git revision into empty destination volumes:

```sh
node deploy/backup.mjs restore /absolute/backup-directory
cd deploy
docker compose up -d --wait
```

Existing destination data is never overwritten. Verify sign-in, a retained
session, connector retrieval, and board history after restoring. Do not run the
original and restored stacks concurrently with the same source credentials.

The previous fixed-identity capture/MCP harness remains in
`deploy/compose.capture.yaml` and `deploy/up-capture.sh` for its existing smoke
checks. It is separate from the multi-user application described here.

Disconnecting GitHub deletes this deployment’s connection and imported data.
It leaves the GitHub App installation in place because other deployments may use it.
An operator can uninstall the app directly in GitHub when nothing else needs it.
