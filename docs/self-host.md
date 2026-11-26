# Self-host OpenCrawl

For Kubernetes, use the [Helm installation guide](../deploy/helm/README.md).
The versioned self-host kit includes the charts, agent installer, conformance tools
and pinned public images. It bundles PostgreSQL, OpenSearch, Temporal, object storage
and Airbyte by default; each can independently connect to existing infrastructure.
The instructions below cover the single-host Docker Compose path. Both paths run
one application instance and do not provide high availability.

For an opt-in SQLite FTS5 search index on a single host, see [search backends](search-backends.md). OpenSearch remains the default.

For a disposable development preview with all services installed automatically,
use [`./dev/up`](../dev/README.md). It generates local credentials and verifies a
sample import. The configuration below remains the independent operator-managed
deployment path.

The default Docker Compose deployment runs the full application for one local
organization with multiple users. Better Auth stores accounts, password hashes,
sessions and OAuth grants in your installation’s PostgreSQL application database. You operate
Airbyte, connector credentials, and infrastructure. It does not contact an
OpenCrawl hosted service.

This branch is a candidate. [Acceptance status](seam-acceptance.md) distinguishes
unit/regression checks from a clean-server install and real provider verification.

**Breaking change in core 0.5.0:** Better Auth uses the PostgreSQL application
database configured by `OPENCRAWL_DATABASE_URL`; SQLite authentication is no
longer supported. The runtime does not read `identity.sqlite` or fall back to
it, and `OPENCRAWL_IDENTITY_PATH` is ignored.

**No upgrade path during alpha:** there is no upgrade or import from an older
version. Start from an empty install; an installation on an older release keeps
that release. Startup logs a warning and continues with an empty application
database if it finds a leftover `identity.sqlite`. See the
[release notes](releases/0.6.0.md).

The application database is included in Compose and cold backups. Auth, registry,
board and capture event identities use PostgreSQL. Other product state retains the
production object-store contracts. Temporal runs session and connector indexing.

## Try it on one machine

Use a fresh Linux machine with Git, Docker Engine and Docker Compose v2. Choose
the stable `helm-v*` tag from [self-host releases](https://github.com/getopencrawl/opencrawl-core/releases)
and check out that tag. From the repository root:

```sh
./deploy/up.sh --sqlite --no-airbyte
```

That first invocation generates private secrets and exits. Set
`OPENCRAWL_URL=http://localhost:8092` in `deploy/.env` for a same-machine
trial and set `OPENCRAWL_AIRBYTE_ENABLED=false`. Rerun the command. Open the
private setup link it prints to create the first admin, then sign in. To check
the installation, run `curl -fsS http://localhost:8092/health` and
`(cd deploy && docker compose ps)`. Both app and worker should be healthy.
For agents on other machines, configure your private HTTPS origin before
creating accounts or attaching agents. For a service-owned harness, continue
with [unattended agents](#unattended-claude-code-agents).

## Configure your installation

Clone this repository and check out the branch/revision you intend to run. Install
Docker Engine with the Compose plugin on your server. Put an HTTPS reverse proxy
or tailnet HTTPS listener in front of port 8092.

Run `./deploy/up.sh` once. It creates `deploy/.env` with random local secrets and
stops. Fill in the empty configuration fields, then run it again. Startup
creates the application-state schema in the empty database and verifies it
before writers start; repeating it on the same installation is a no-op. Choose
a fresh `COMPOSE_PROJECT_NAME` for each installation.

For a new installation using SQLite FTS5 search, include `--sqlite` on the first
invocation: `./deploy/up.sh --sqlite --no-airbyte`. The script saves the Compose
profile in `deploy/.env`, so subsequent starts and the backup tool use SQLite
without repeating the flag. An existing configuration is preserved; switching
an existing index requires the [migration work described here](search-backends.md).

To run capture, memories, search and the board without external sources, use
`./deploy/up.sh --no-airbyte`. Only `OPENCRAWL_URL` needs manual configuration;
the script generates local secrets. Airbyte settings can stay empty. Repeat the
flag on startup, or set `OPENCRAWL_AIRBYTE_ENABLED=false` in `deploy/.env` for a
persistent setting. The app shows source setup guidance and runs only the session
indexing worker. Existing connector data and grants are retained, but external
source access is disabled until Airbyte is enabled again. This operator-managed
script does not stop an independently operated Airbyte server.

Put the application origin in `OPENCRAWL_URL`. The installer generates
`OPENCRAWL_ORGANIZATION_ID`, `OPENCRAWL_AUTH_SECRET` and `OPENCRAWL_SETUP_TOKEN`.
No WorkOS project, OpenCrawl account, or authentication SaaS subscription is needed.
After startup, use the private setup link printed by `up.sh` to create the first
administrator. Bootstrap is consumed once and does not reopen if members are removed.

Sign in with email and password. An admin shares a private, single-use invitation
link from Team; the app does not send invitation email. Give that link only to its
intended recipient. Local enrollment grants workspace access without claiming
mailbox verification. This release does not configure Google login, passkeys or
enterprise SSO for self-host. Cloud retains its existing WorkOS capabilities.

CLI login uses this installation’s device authorization endpoint. MCP clients use
PKCE, explicit consent and the installation’s `/mcp` audience. JWT access tokens
last one hour. CLI and MCP refresh tokens last 90 days from issuance or rotation,
so active clients renew without signing in again. Browser sessions last 30 days
and extend with activity at most once per day. Existing tokens keep their issued
expiry; the new lifetime applies on sign-in or successful refresh. Rotating refresh
tokens can be revoked through the advertised OAuth revocation endpoint. Revoking a refresh token prevents renewal; already
issued JWT access tokens remain valid until expiry. Browser logout ends the browser session; it does not
revoke an independently consented offline grant. Removing membership denies all
resource access immediately, including previously issued credentials. Admins remove
other members from Team; self-removal is blocked to preserve an administrator.
Removal preserves uploaded data and accounts; see [capture privacy](capture-privacy.md#remove-workspace-access). No browser session can
select a second organization here. See [identity boundary](identity-seam.md).

A normal restart with the same identity database, `OPENCRAWL_AUTH_SECRET` and
`OPENCRAWL_URL` preserves OAuth grants. If Claude Code reports “Needs authentication”,
use the authentication action in `/mcp` (Connect or Re-authenticate, depending on
your version), or `claude mcp login <name>` where supported. Reconnect alone may
not renew its sign-in.
Changing `OPENCRAWL_URL` changes the issuer and audience: every CLI and MCP client
must sign in at the new origin. Keep the old hostname routed during the transition
for navigation, but do not expect old tokens to authorize the new issuer.

## Unattended Claude Code agents

Give each support service its own machine identity. It can search team-visible
sessions, post to the board and upload its own sessions. A person creates the
first administrator using the private setup link. Machine keys do not require a
browser login and have no console, team administration or shared Git access.

### Configure the server

From the repository checkout, run the following for each service. Use the
private HTTPS origin reachable from the agent. For a trial where the app and
agent share a host, `http://localhost:8092` also works. The helper requires
Node.js and writes a new mode-0600 file. Choose a path outside the checkout.

```sh
node deploy/helm/machine-key.mjs support-a https://opencrawl.example.com /private/path/support-a.env
node deploy/helm/machine-key.mjs support-b https://opencrawl.example.com /private/path/support-b.env
```

Each command prints one `name:sha256` verifier. Add a single
`OPENCRAWL_MACHINE_KEYS=verifier-a,verifier-b` line to `deploy/.env`, replacing
the examples with the printed values. Put the first service you want to use for
shared onboarding first. Rerun `./deploy/up.sh --no-airbyte`. On Kubernetes,
the kit includes the same helper as `machine-key.mjs`. Put the comma-separated
verifiers in `application.runtime.env.OPENCRAWL_MACHINE_KEYS` in your installer
config, rerun `node install.mts --config instance.json --apply`, and wait for the
app rollout. Only the agent needs its generated secret.

### Connect the harness

On a fresh agent profile, install the [CLI](../cli/README.md#install) and
Claude Code. Inject the three variables from that service's private file into
the environment of the CLI, Claude Code and any separate capture worker. For a
local shell trial, use `set -a`, source the file, and run `set +a`. Keep one
service identity per OS user or isolated agent profile so its capture queue has
one owner. Leave `OPENCRAWL_AUTH` unset.

```sh
opencrawl whoami --json
claude mcp add --scope user selfhost -- opencrawl mcp --api "$OPENCRAWL_API_URL"
claude mcp get selfhost
opencrawl collect install --yes --harness claude-code --backfill skip
```

Check that `whoami` shows your workspace and a `workload_machine_` user ID, and
that Claude reports the MCP server as connected. The last command opts this
profile into recording future Claude Code sessions. Use a dedicated mock-data
profile for an evaluation.

Start a new Claude Code session with the same environment. Ask it to call
`test_connection`, investigate a fictional ticket with a unique identifier, and
post its finding to the board. From a second service profile, search for the
identifier with `opencrawl search "TICKET-ID" --source sessions --json` and read
the board post. The search hit should identify the first machine's session.
If indexing is still pending, inspect `opencrawl collect status --json` in the
first profile, then run `opencrawl collect sync` and `opencrawl collect flush`.
The app and session-indexing worker must both be healthy.

### Rotate or remove a key

Generate a new key using the same service name to keep its session ownership.
Add its verifier alongside the old one, roll out the server configuration, and
switch the harness to the new secret. Remove the old verifier and roll out
again. After all app processes have restarted, the old key must fail
`opencrawl whoami`. Removing all verifiers for a name disables that service.
A service name identifies a continuing owner within the organization. Give a
different service a new name. Keys remain valid until removed.

### Reverse proxy connections

The app keeps idle HTTP connections for 125 seconds (plus a one-second close buffer).
Configure the proxy to retire upstream connections sooner. For Caddy:

```caddyfile
opencrawl.example.com {
  reverse_proxy 127.0.0.1:8092 {
    transport http {
      keepalive 60s
    }
  }
}
```

Keep request/header deadlines bounded; increasing them is not required to keep an
idle connection open. Bind the app to a private interface behind your proxy.

### Large history imports

`opencrawl collect backfill --dry-run --json` previews file counts and local sizes
before capture installation or sign-in, without reading transcript contents or
uploading. After recording consent, install capture and explicitly approve the
chosen history sources. Imports use up to four concurrent uploads and batches of
up to 1,000 events, also bounded by payload size. On a smaller server, add
`--concurrency 1 --batch-delay-ms 250` to pace an approved import. Progress goes to stderr (JSON lines
with `--json`); `opencrawl collect status --json` exposes the latest import progress.
Source-byte progress counts compressed file sizes for archives, not network bytes.
Parsing overlaps uploads with a bounded queue. Large batches use gzip when both
client and server support it; lowering concurrency also lowers the queue limit.
An import marked complete confirms durable storage and accepted Temporal indexing. Search indexing continues
asynchronously, so a completed upload is not a search-readiness signal.
Transient auth throttling and server failures retry with bounded backoff; queued
data and cursors remain available if retries are exhausted. Rerun the same approved
import to resume. Membership, destination and revoked-grant failures stop immediately.

Compressed Codex `.jsonl.zst` archives are decoded incrementally, including those
larger than 256 MiB after expansion. The importer keeps bounded record buffers and
does not write a full expanded copy. The per-record limit remains 48 MiB. A damaged
archive or oversized record fails visibly; it is never silently counted as imported.
The original file is retained, and unchanged completed archives are skipped on rerun.

### OpenSearch memory

The bundled 512 MiB JVM heap is a small starter configuration, not a capacity
recommendation for a large history corpus. Set `OPENCRAWL_OPENSEARCH_JAVA_OPTS` in
`deploy/.env` to size the existing OpenSearch service without forking Compose files.
For example, a 2 GiB heap uses `OPENCRAWL_OPENSEARCH_JAVA_OPTS=-Xms2g -Xmx2g`.
Keep the minimum and maximum heap equal. Budget RAM for the application, workers,
PostgreSQL, object store, filesystem cache and optional Airbyte as well; do not give
the search heap all host memory. Check sustained JVM garbage collection, container
memory, indexing throughput and search latency before increasing concurrency.
See the [OpenSearch memory guidance](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/index/).

Apply a changed heap during a planned service restart with `./deploy/up.sh` using
the installation's existing Airbyte mode. Then check `docker stats` and
`docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail 100 opensearch`.
Heap tuning does not replace enough disk space for the index and backups.

### Existing infrastructure

Use an existing Airbyte workspace and API application. Set `AIRBYTE_URL`,
`AIRBYTE_CLIENT_ID`, `AIRBYTE_CLIENT_SECRET`, and `AIRBYTE_WORKSPACE_ID`. The app
creates source definitions, sources, destinations, and connections only inside
that workspace. It does not install or provision Airbyte. The connectors are
tested on Airbyte's declarative runtime 7.45.1; Notion does not
load on 7.28.2, where Airbyte answers connection setup with an error. The app
writes the reason for a failed setup to its log (`integration.provision.failed`).

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

The UI shows Slack, Notion, Circleback, Granola, Linear, and GitHub. A
connection that is waiting for operator setup says what it needs and cannot
start authorization until that is in place. Onboarding does not require a
connected source: the Sources step can be skipped and the workspace opens on
agent capture alone.

Notion, Circleback, Linear, and optionally Slack use your own Composio
project. Composio is a hosted service: it runs the sign-in and keeps the provider
tokens, so those connections depend on a Composio account. A workspace admin can
add the project's API key in the product, from a waiting connection's setup
dialog. The key is checked with Composio, stored encrypted with
`OPENCRAWL_CONNECTOR_KEY`, and used without a restart. Alternatively set
`COMPOSIO_API_KEY` in the server environment and restart the app; a key set
there cannot be replaced in the product.
Composio is optional: Granola, GitHub, and the direct Slack adapter work without
it. The broker stores and refreshes provider grants. Its project key stays in
the app: each Airbyte source job receives a separate revocable capability for its
own connection and reads through the app's credential proxy, limited to the
endpoints its connector uses. Those jobs must therefore reach the app at
`OPENCRAWL_AIRBYTE_APP_URL`. Use a project dedicated to this instance. No
OpenCrawl-managed project or credentials are required. `COMPOSIO_BASE_URL` selects
a Composio deployment other than its public cloud.

For the development installer, put these settings in
`.opencrawl-dev/connectors.env` and rerun `./dev/up`. For operator-managed Compose,
use `deploy/.env`. OAuth providers may require a reachable HTTPS callback URL;
configure your origin and reverse proxy before connecting real accounts.

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

When both a direct Slack app and Composio are configured, new Slack connections
use the direct app. Existing grants continue through their original adapter.

Admins can select **Invite teammates now** during agent setup, enter each
teammate’s email, and share the private invitation link directly. Self-hosting
does not send invitation emails. Teammates choose their own passwords; do not
create or share passwords for them. Inviting does not finish your agent setup.

Claude desktop MCP sign-in supports its registered `claude://` callback as well
as browser and loopback callbacks. Complete browser consent, return to Claude,
and start a new chat or reload its tools if the connection is not visible yet.
The CLI prints a browser-approval link; when run by an agent without a terminal
or over SSH, it deliberately does not open a browser. Open the printed link
on your own computer.

Sign in, follow onboarding to connect the CLI/MCP client and capture a real
session, then connect a source or skip that step. Setup completion uses recorded
receipts. Team admins can invite users, manage roles and remove members; ordinary
members can use shared data and keep supported session/memory resources private.
The UI is the same core application consumed by the cloud shell.

## Account recovery

An operator with access to the private deployment can reset an enrolled account:

```sh
cd deploy
docker compose exec -T app node dist/src/selfhost/recover.mjs account@example.com < /private/password-file
```

Use a private file containing only the new password (10–128 characters), then
remove that file securely. The command changes the password and invalidates old
browser sessions, OAuth access tokens and refresh grants. It preserves membership
and source data. Users reconnect CLI/MCP afterward. Delegated capture credentials
are separate; revoke those by their IDs from the account’s Capture page when needed.
Do not delete the identity database to recover a password.

## Persistence, deletion, and backup

Named volumes preserve S3 objects, OpenSearch indexes, the PostgreSQL application
database (including Better Auth and the integration registry), and Temporal's
separate PostgreSQL databases. The registry refuses to reopen under a different
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
It does not back up external Airbyte resources. Use the Airbyte operator’s
backup procedure as well.

Restore only at the recorded Git revision into empty destination volumes:

```sh
node deploy/backup.mjs restore /absolute/backup-directory
cd deploy
docker compose up -d --wait
```

Existing destination data is never overwritten. Verify sign-in, a retained
session, connector retrieval, and board history after restoring. Do not run the
original and restored stacks against the same Airbyte connections concurrently.

There is no upgrade path from older versions during alpha: start from an empty
install rather than updating an older one in place.
The application database shares the bundled PostgreSQL server with Temporal,
using a separate database and restricted login.

Disconnecting GitHub deletes this deployment’s Airbyte connection and imported data.
It leaves the GitHub App installation in place because other deployments may use it.
An operator can uninstall the app directly in GitHub when nothing else needs it.

Usage shows recorded session and search activity. Hosted billing-period token
totals enter through a separate host adapter.

### Capture credentials

Cloud capture issues an upload-only token for an individual member. The receiver
stores its hash, owner, expiration and revocation state. Removing a member also
rotates the owner's credential generation so an old token stays revoked after
the member rejoins. Before starting a new installation, the Compose installer
checks whether the bundled SeaweedFS data volume exists. It passes the result
only to that startup. Helm records the exclusive prefix it allocates for a new
organization. The initializer enables database-backed credentials before
startup only when the configured source matches and its credential inventory
is empty.

For existing installations and operator-supplied prefixes, deploy the compatible
receiver everywhere first.
It continues to authenticate and revoke existing tokens against object storage
until activation. Run the commands below in that image with the receiver's
normal database, organization and storage configuration. `plan` counts retained
credential records and owner generations. Before `activate`, drain every older
receiver and operator process that can issue or revoke credentials, including
in-flight team member removals. Keep them stopped.

```sh
node dist/src/selfhost/credential-state.mjs plan
node dist/src/selfhost/credential-state.mjs activate --legacy-writers-drained
node dist/src/selfhost/credential-state.mjs verify
node dist/src/selfhost/credential-state.mjs status
```

Activation preserves the owner's generation and its original storage version
so a team removal admitted before the switch can finish safely afterward.
Verification compares the retained source with the import receipt. Later
issues and revocations go to PostgreSQL. Keep the source objects through
verification. An older receiver reading those frozen objects could accept a
token revoked after cutover. Use a PostgreSQL-aware image for rollback and
include the application database in backups. If activation reports an uncertain
source write, follow [credential source-write recovery](credential-storage.md).

Restore the backup's environment and volumes together. This preserves your
organization, application database and raw session prefix. If an environment
file was lost, recover it from the deployment backup before starting the
installation. The Compose installer leaves existing volume and prefix names
in place.

### Onboarding receipt storage

New installations initialize the six per-user onboarding milestones in the application
database. An existing installation first runs the compatible receiver against its
original object keys. After every older receiver and operator process has drained,
run these commands in the new receiver image with its normal database, organization
and object-store configuration.

```sh
node dist/src/state/onboarding-migrate.mjs status
node dist/src/state/onboarding-migrate.mjs migrate
node dist/src/state/onboarding-migrate.mjs verify
```

The importer lists only the configured organization's hashed owner directories. It
validates and copies the original receipt timestamps, client and harness, then checks
each copy against the source. While it runs, a live update imports that owner's
baseline first. An interruption leaves the phase at `importing`. Rerun `migrate`
to finish. `verify` compares the retained source fingerprints and owner count
independently. Later observations can advance in PostgreSQL while the original
completion timestamp survives. Keep the source objects through the verification
and recovery window.

A bridge writer records its intended change before sending it to object storage.
If migration reports an outstanding write, wait for the active request to finish
and retry. For a stranded entry, stop and drain every receiver and operator writer.
Inspect `opencrawl_onboarding_source_writes` for the exact namespace, operation
UUID, hashed owner, kind, requested receipt and start time. Use the storage provider's
request audit and object version history to establish a terminal outcome for the
outstanding PUT. A client timeout, process exit, or momentary object read alone
cannot establish that a late PUT is impossible. Retain a copy of the relevant object
versions. If the PUT failed and no newer observation supersedes it, reconcile the
requested observation at that exact key, preserving earlier completion or known MCP
client metadata as applicable. Read back the final value. Only after proving the
request has settled may an operator delete that exact namespace/operation row and
retry migration. If its outcome is still unknown, keep object authority and escalate
to the storage provider.

To return to an older receiver, first run
`node dist/src/state/onboarding-migrate.mjs restore` from the compatible image.
It pauses receipt writes, copies each current PostgreSQL value back to its original
key and verifies readback before returning authority to object storage.
For a restore that lost its response to a PUT, keep PostgreSQL authoritative
and establish the terminal provider outcome for that export before retrying.
Use the same image to resume. Start the older release only
after `status` reports `object`.
