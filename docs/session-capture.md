# Session capture

The CLI installs capture for local Claude Code and Codex sessions, including sessions run by their desktop apps. Run `opencrawl login`, then `opencrawl collect install`. Codex requires reviewing/trusting the installed commands in `/hooks` or desktop Settings > Hooks. Existing sessions may need a restart.

Capture uses command hooks and incremental reads of native JSONL transcripts. A macOS LaunchAgent or Linux user timer reconciles active/new transcripts every minute. Windows currently uses hooks; run `opencrawl collect sync` to reconcile manually. The installer preserves existing hook groups, backs up changed files, and rolls back configuration writes if installation fails. It uses absolute executable paths so desktop launch environments do not need the interactive shell's PATH.

## Contents and identity

Batches include deployment-derived user/tenant identity, stable installation ID, native session ID, harness, hostname, timestamps, byte ordering, native message/parent IDs, tool call IDs, and available parent-session/agent IDs. Origin is CLI, desktop, subagent, or unknown, with native evidence retained. Explicit Codex CLI/exec source takes precedence over an inherited desktop originator. Claude sdk-cli is CLI. Unknown origin remains explicit.

User and assistant messages, tool inputs/results, attachment records, available reasoning summaries, compaction boundaries and selected runtime metadata are retained. Repeated system/developer prompts and encrypted reasoning are excluded. Inline attachment bytes and referenced local image/file bytes are stored by SHA-256; batches refer to those blobs. Missing, remote-only and over-limit attachments have explicit statuses. Remote URLs are retained without fetching them.

Uploads are limited to 16 MiB per batch and 32 MiB per attachment. Oversized transcript records remain locally pending and surface in status. This captures what the harness persists or provides to its hooks; it is not an inference proxy and cannot recover omitted or truncated native records, cloud-only sessions, or deleted attachment files.

Installation enrolls new sessions and existing sessions modified afterward. Existing active transcripts are read from the beginning on first encounter. It does not automatically import inactive historical sessions.

## Reliability and control

`opencrawl collect status --json` shows the bound owner, installation, pending batches, last receipt and last error. `collect sync` reconciles transcripts and uploads; `collect flush` only uploads the queue. `collect uninstall` stops collection and removes only OpenCrawl's hooks; it preserves queued data. Explicit flush remains available after uninstall.

The collector persists batches before advancing cursors, holds incomplete trailing JSONL lines, and deletes batches only after a matching durable receipt. Repeated transcript records have stable IDs; hook/transcript duplicates remain available for downstream deduplication. Account changes cannot silently relabel queued sessions. Use a separate OPENCRAWL_CONFIG_HOME for another account/deployment. Local spool/configuration files are private to the OS user. Unreferenced attachment blobs are reclaimed after a 24-hour grace period.

## Single-tenant deployment

Core owns the shared ingestion protocol and requires an explicit principal and durable store adapter. Domain logic imports no WorkOS or AWS code. An optional S3-compatible adapter is exported separately and shared with the existing operator integration. A runnable single-tenant receiver is included:

```sh
export OPENCRAWL_SESSIONS_TOKEN="$(openssl rand -hex 32)"
export OPENCRAWL_SESSION_DIRECTORY=/var/lib/opencrawl/sessions
export OPENCRAWL_USER_ID=owner
export OPENCRAWL_USER_NAME="Your name"
npm run sessions
# In the CLI environment, with the same receiver token:
opencrawl collect install --api http://localhost:8093
```

The receiver defaults to loopback. Use HTTPS when exposing it remotely. The CLI securely saves the receiver token for later hook/background uploads. The operator-configured identity defines the sole tenant/owner; the uploaded body cannot change it. Storage persists across receiver restarts. Other deployments can supply their own auth and store adapters.

## Hosted deployment

The hosted shell verifies the OAuth token and fresh verified WorkOS user. A signed organization claim also requires current active membership; otherwise the user has a personal tenant. The shared core enforces the resulting neutral principal. Each environment, tenant and user has a separate object prefix; attachment deduplication is scoped to that owner. The shell supplies the S3 adapter and deployment configuration. No WorkOS account or AWS dependency is required for the single-tenant offering.

The HTTP protocol provides identity, attachment upload, immutable batch upload and receipt-based batch readback under /api/sessions/. Receipt readback is subject to the same owner scope as uploads.

## Persistence, backup and versioning

For the local receiver, stop writes before copying the entire configured session directory to a backup. Restore that directory with owner-only permissions and the same configured tenant/user identity, then restart the receiver; receipt readback verifies the restored records. Preserve the receiver token separately. Never merge backups belonging to different configured owners.

Schema version 1 uses immutable batches and attachment objects; this first release requires no data migration. Keep existing objects when upgrading or rolling back the receiver. A binary without the capture API cannot serve these records, but does not erase them. Before downgrading the CLI to a version without capture, run collect uninstall to remove its hooks and scheduler. Hosted object lifecycle and backups remain the operator's responsibility.

Revocation is checked at upload/read time. Queued background uploads re-authenticate and must match the enrollment identity. Hosted organization membership is checked on every request; removing membership rejects subsequent requests. Existing valid OAuth access tokens retain their ordinary token lifetime, while a failed refresh stops later uploads. Local collection continues until uninstall; failed uploads remain queued.
