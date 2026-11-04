# Airbyte

Self-hosted [Airbyte](https://github.com/airbytehq/airbyte) moves data from users'
tools into an S3 bucket, which the OpenCrawl indexer reads from.

Verified with Airbyte 2.4.0 (Helm chart 2.4.0), abctl v0.30.4 and Node 22/24.

| File | Purpose |
| --- | --- |
| `local.sh` | Install and run Airbyte on one machine |
| `cli.mjs` | Connect sources (including OAuth sign-in), link them to the S3 landing bucket, run syncs |
| `client.mjs` | Zero-dependency client for the Airbyte API |
| `helm/` | Production values for Kubernetes (external Postgres and S3 for Airbyte's own state) |
| `.env.example` | Every setting the scripts read |

## Local quickstart

Requires Docker and an existing S3 bucket that synced data lands in. Airbyte recommends 4 CPUs and 8 GB of RAM. On smaller machines
`local.sh` switches to `--low-resource-mode`, which disables the Connector Builder.

```sh
integrations/airbyte/local.sh up
node integrations/airbyte/cli.mjs status
```

`up` performs these steps:

1. Downloads abctl, pinned and checksum-verified.
2. Installs Airbyte into a local kind cluster. The first run takes 5–15 minutes.
3. Writes `integrations/airbyte/.env` with mode 600. It contains the Airbyte API
   credentials.

Then set `OPENCRAWL_LANDING_S3_BUCKET` (and region, plus access keys unless the
machine has an AWS role) in `.env`.

Running `up` again is safe. The Airbyte UI is at http://localhost:8000; get the
login with `local.sh credentials`.

Try a full sync with sample data, which needs no account:

```sh
echo '{"count": 100}' > /tmp/faker.json
node integrations/airbyte/cli.mjs connect faker --config /tmp/faker.json --name "Sample data" --sync
node integrations/airbyte/cli.mjs list
```

Records land as JSONL under `s3://<bucket>/opencrawl/sample_data/<stream>/`.
Each connected source gets its own prefix.

## Connecting sources

```sh
node integrations/airbyte/cli.mjs catalog notion        # find the source type
node integrations/airbyte/cli.mjs connect notion --cron "0 0 */6 * * ?"
```

`connect` performs these steps:

1. Creates the source.
2. Creates the `OpenCrawl landing` destination, if it doesn't exist.
3. Creates a connection with every stream enabled, on a manual schedule or the
   Quartz `--cron` you give.
4. With `--sync`, runs the first sync and waits for it.

Connector settings go in `--config file.json`. The required fields are listed on
each connector's page at https://docs.airbyte.com/integrations/sources/.

**API-key sources** (GitHub tokens, Slack bot tokens, databases): put the
credentials in `--config`. If the connector also supports OAuth, add `--no-oauth`.

**OAuth sources** (Google Drive, Notion, Slack, Salesforce, ...): self-managed
Airbyte has no shared OAuth apps, so each deployment registers its own once:

1. Create an OAuth app with the provider. Register
   `AIRBYTE_OAUTH_REDIRECT_URL` (default `http://127.0.0.1:8765/callback`) as its
   redirect URL.
2. Add `AIRBYTE_OAUTH_<SOURCE_TYPE>_CLIENT_ID` and `_CLIENT_SECRET` to `.env`, for
   example `AIRBYTE_OAUTH_GOOGLE_DRIVE_CLIENT_ID`.
3. Run `cli.mjs connect google-drive --config drive.json`, open the printed URL
   and sign in. The CLI catches the redirect on loopback. If your browser runs on
   another machine, paste the redirected URL into the terminal instead.

Airbyte exchanges the code and keeps the tokens in its own secret store. Behind
the scenes, the CLI stores the OAuth app on the workspace, gets the consent URL,
completes the exchange, and places the returned tokens into the connector
configuration, using the same steps as the Airbyte UI.

Three API details were verified against a live 2.4.0 install:

- The public API's `POST /sources/initiateOAuth` and
  `PUT /workspaces/{id}/oauthCredentials` return **501** on Community. That is
  why OAuth goes through the config API (`/api/v1/source_oauths/*`).
- `get_consent_url` and `complete_oauth` fail with a 500 unless
  `oAuthInputConfiguration` is sent, even as `{}`.
- Sources are validated against the full spec, so the OAuth app's `client_id`
  and `client_secret` must be in the source configuration. The CLI adds them.

## Landing store

Every connection writes to one S3 destination named `OpenCrawl landing`, an
Airbyte-certified GA connector. Records are uncompressed JSONL at
`<OPENCRAWL_LANDING_S3_PATH>/<source>/<stream>/`, one object per sync batch, each
line carrying `_airbyte_raw_id`, `_airbyte_extracted_at`, `_airbyte_meta`,
`_airbyte_generation_id` and the record under `_airbyte_data`. Omit the access
keys to use the instance role. The indexer that turns landed
records into OpenCrawl documents is the next piece of work and does not exist yet.

## Production (Kubernetes)

Airbyte's Helm chart V2 is the only supported chart since Airbyte 2.1. Docker
Compose deployments ended with Airbyte 1.0.

```sh
cp integrations/airbyte/helm/secret.example.yaml secret.yaml   # fill in, keep out of git
kubectl create namespace airbyte
kubectl apply -n airbyte -f secret.yaml
helm repo add airbyte-v2 https://airbytehq.github.io/charts
helm upgrade --install airbyte airbyte-v2/airbyte --version 2.4.0 \
  -n airbyte -f integrations/airbyte/helm/values.yaml
```

`helm/values.yaml` sets up the following:

- external Postgres 13–17 for Airbyte's own state
- an S3 bucket for logs and state
- fixed API credentials taken from the secret
- nginx ingress with TLS

Point the CLI at that deployment with `AIRBYTE_URL=https://airbyte.example.com`
and the client ID and secret from the secret. Use a hosted redirect URL for
OAuth apps, such as a page that shows the redirected URL so the user can paste
it into the CLI.

For a single VM, `local.sh up` with `AIRBYTE_HOST=airbyte.example.com` also
works. Put TLS in front of it, or add `--insecure-cookies` for plain HTTP inside
a private network.

## Operations

| Task | Command |
| --- | --- |
| Status | `local.sh status` |
| UI login | `local.sh credentials` (change it with `abctl local credentials --email … --password …`) |
| Stop and uninstall, keeping data | `local.sh down` |
| Delete everything | `local.sh destroy` |
| Server logs | `docker exec airbyte-abctl-control-plane kubectl logs -n airbyte-abctl deploy/airbyte-abctl-server` |
| Pin other versions | `ABCTL_VERSION=… AIRBYTE_CHART_VERSION=… local.sh up` |

abctl keeps everything in `~/.airbyte/abctl`. It reports anonymous usage by
default; set `DO_NOT_TRACK=1` to opt out.

The `Error reading pgdata version file: permission denied` error appears when
abctl reinstalls over existing data. `local.sh up` skips reinstalling if Airbyte
is already deployed. Otherwise run `local.sh down` before reinstalling.
