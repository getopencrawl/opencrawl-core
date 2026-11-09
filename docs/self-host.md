# Self-host OpenCrawl

The default Docker Compose deployment runs the full application for one WorkOS
organization with multiple users. You operate the WorkOS project, Airbyte
workspace, connector credentials, and infrastructure. It does not contact an
OpenCrawl hosted service.

This branch is a candidate. [Acceptance status](seam-acceptance.md) distinguishes
unit/regression checks from a clean-server install and real provider verification.

## Configure your installation

Clone this repository and check out the branch/revision you intend to run. Install
Docker Engine with the Compose plugin on your server. Put an HTTPS reverse proxy
or tailnet HTTPS listener in front of port 8092.

Run `./deploy/up.sh` once. It creates `deploy/.env` with random local secrets and
stops. Fill in the empty configuration fields, then run it again. You can also
run `docker compose up -d --build --wait` directly from `deploy/` after configuring
`.env`. Choose a fresh `COMPOSE_PROJECT_NAME` for each installation.

Configure WorkOS AuthKit with:

- Your client ID, server API key, and AuthKit origin.
- One organization ID. Add the initial user to that organization as `admin`.
- Redirect URI: `https://YOUR-APP/auth/callback`.
- Sign-in endpoint: `https://YOUR-APP/auth/login`.
- Logout redirect: `https://YOUR-APP/signed-out`.
- The device authorization flow for the CLI and OAuth resource/audience
  `https://YOUR-APP/mcp` for MCP clients.

Put the application origin in `OPENCRAWL_URL`. Browser, CLI, and MCP admission
always checks membership in the configured organization. Users may belong to
other WorkOS organizations; that does not give them a second workspace here.

Use an existing Airbyte workspace and API application. Set `AIRBYTE_URL`,
`AIRBYTE_CLIENT_ID`, `AIRBYTE_CLIENT_SECRET`, and `AIRBYTE_WORKSPACE_ID`. The app
creates source definitions, sources, destinations, and connections only inside
that workspace. It does not install or provision Airbyte.

The stack includes SeaweedFS S3, OpenSearch, and PostgreSQL-backed Temporal. Set
`OPENCRAWL_AIRBYTE_S3_ENDPOINT` to the S3 address reachable **from Airbyte connector
jobs**. On a separate Airbyte server, bind `OPENCRAWL_S3_BIND` to a private server
interface and permit that private connection. Keep S3 off the public internet.
`OPENCRAWL_AIRBYTE_APP_URL` similarly lets Airbyte reach the app's credential
proxy; it defaults to the public HTTPS application origin. Docker's `s3` hostname
is meaningful only inside this Compose network.

For existing operator-managed S3/OpenSearch/Temporal services, use a Compose
override to supply their endpoints and credentials to `app` and `worker` and
remove the corresponding local service dependencies. Keep a unique object
prefix and search namespace. The runtime accepts S3-compatible endpoints and
OpenSearch basic authentication; Temporal adapters also accept explicit SDK
connection options.

## Connect sources

Slack uses your own Slack app. Configure user scopes `channels:read`,
`channels:history`, `search:read`, `users:read`, `team:read`, and `emoji:read`; set
its redirect to `https://YOUR-APP/oauth/connectors/slack/callback`. Put its client
ID and secret in `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`. Connect Slack from
the app. OAuth grants are encrypted using `OPENCRAWL_CONNECTOR_KEY`. Airbyte gets
a separate revocable capability for that source; it does not get your OAuth
client secret or provider token. Public-channel restrictions apply in the proxy
and indexing pipeline. Token rotation is supported. An interrupted token
exchange with an unknown outcome requires reconnecting that source.

Granola takes a **workspace** API key in the Sources UI; personal API keys are
not supported. GitHub uses your own read-only GitHub App. Its source container is
in `connectors/github/`; build/register it in your Airbyte workspace as
`OpenCrawl GitHub (app)`. Set `GITHUB_APP` to the base64 JSON bundle described by
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
registered Airbyte source image when upgrading this connector's source.

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
restarting; pending Airbyte creation intents are reconciled before any retry.

Disconnect first stops/removes Airbyte resources, revokes the source grant, and
deletes its landed objects. Search denies the disconnected binding immediately.
The worker deletes indexed documents and repeats the purge after in-flight
writes have settled. Session and memory deletion use the shared core lifecycle.

Pause this installation's connections in your Airbyte instance and wait until
their current jobs finish before taking an offline backup. Airbyte runs outside
this Compose stack; stopping OpenCrawl does not stop an external sync. Keep those
connections paused throughout a restore rehearsal, then resume them only after
choosing which copy will continue operating.

Create an offline backup with:

```sh
node deploy/backup.mjs create /absolute/new-backup-directory
```

The script stops this Compose stack, saves its data volumes and `.env` with
restricted permissions, records checksums and source revision, then restarts it.
The environment includes the encryption key: preserve it alongside the backup.
It does not back up external WorkOS or Airbyte resources. Use those operators'
backup procedures as well.

Restore only at the recorded Git revision into empty destination volumes:

```sh
node deploy/backup.mjs restore /absolute/backup-directory
cd deploy
docker compose up -d --wait
```

Existing destination data is never overwritten. Verify sign-in, a retained
session, connector retrieval, and board history after restoring. Do not run the
original and restored stacks against the same Airbyte connections concurrently.

The previous fixed-identity capture/MCP harness remains in
`deploy/compose.capture.yaml` and `deploy/up-capture.sh` for its existing smoke
checks. It is separate from the multi-user application described here.

Disconnecting GitHub deletes this deployment’s Airbyte connection and imported data.
It leaves the GitHub App installation in place because other deployments may use it.
An operator can uninstall the app directly in GitHub when nothing else needs it.
