# Session capture

Read [capture privacy and controls](capture-privacy.md) before enabling collection.

The CLI installs capture for local Claude Code and Codex sessions, including sessions run by their desktop apps, and for [Grok Bot](#grok-bot) on a Bot's cloud computer. Run `opencrawl login`, then `opencrawl collect install`. Codex requires reviewing/trusting the installed commands in `/hooks` or desktop Settings > Hooks. Existing sessions may need a restart.

Capture uses command hooks and incremental reads of native JSONL transcripts. The harness supervises asynchronous hooks. Each hook durably saves its event, then attempts a nonblocking uploader lock; the winner uploads in that same process, and competing hooks exit. Unix dispatch uses exec to preserve the harness-owned PID. Capture never starts detached children. Each uploader has a 90-second process deadline and exits on detected parent loss (checked every second), including while waiting for locks or network responses. Durable unacknowledged bytes remain for the next hook. Foreground flush/backfill is unaffected. If the harness itself dies, reaping adopted children remains the host’s responsibility. The same mechanism runs on macOS, Linux and Windows without an init service. Legacy OpenCrawl LaunchAgents/user timers are removed during installation. The installer preserves existing hook groups, backs up changed files, and rolls back configuration writes if installation fails. It uses absolute executable paths so desktop launch environments do not need the interactive shell's PATH.

## Grok Bot

Grok Bot runs a person's Bots on one cloud computer and loads Cursor-format
command hooks from `~/.cursor/hooks.json` there. Install on that computer, from a
Bot's shell, not on the device that shows the chat:

```sh
npm i -g @getopencrawl/cli@next
opencrawl login --no-browser          # or an upload-only OPENCRAWL_SESSIONS_TOKEN
opencrawl collect install --yes --harness grok-bot
```

`--harness grok-bot` is never implied. Cursor reads the same `~/.cursor/hooks.json`
on a developer machine, so installing there would record Cursor sessions under
the Grok Bot name. Existing entries in the file are preserved; uninstall removes
only OpenCrawl's.

The collector reads no Grok Bot transcript. A session is built from the hook
payloads, in the event shapes used for Claude Code and Codex:

| Hook | Captured as |
| --- | --- |
| `beforeSubmitPrompt` | The person's message, with paths of attached files and rules (never their bytes) |
| `afterAgentResponse` | The Bot's reply |
| `afterAgentThought` | A reasoning summary |
| `postToolUse`, `postToolUseFailure` | The tool call and its result or error, paired by `tool_use_id` |
| `preCompact` | A compaction marker |
| `sessionStart`, `sessionEnd`, `stop` | Lifecycle evidence, stored but not indexed |

What differs from transcript capture:

- **The hooks cannot block or deny.** Grok Bot waits for each hook, so the hook
  answers first, saves its payload locally and returns. No permission hook
  (`preToolUse`, `subagentStart`, the `before*` hooks) is registered, because an
  invalid answer to one blocks the action; `postToolUse` already carries the tool
  input. The process never exits with the blocking code 2.
- **Uploads are bounded.** A hook uploads at a turn boundary (`stop`,
  `sessionStart`, `sessionEnd`) or when 20 seconds have passed since the last
  pass, and the process ends at five seconds regardless, inside its ten-second
  hook timeout. A failed or cut-off pass backs off for one minute. Unsent work
  stays in the local spool; `collect flush` drains it on demand.
- **Capture starts when a Bot loads the hooks.** Nothing earlier is read and
  there is no history import. Bots that are already running may keep the hook
  configuration they loaded; verify from a newly created Bot.
- **One installation covers the whole computer.** Every Bot the person runs
  there is recorded and attributed to the person who installed capture. Do not
  install on a shared Bot's computer.
- **Connected-app results are not captured.** For HTTP MCP servers the runtime
  passes hooks `{"redacted": true}` instead of the tool result, so only the
  call's arguments are recorded. Shell, file and computer tools carry their
  results; inline base64 images in them are stored as attachments.
- **Payloads over 15 MiB are recorded as a size-only marker**, so one oversized
  tool result cannot hold back the rest of the session.
- **Origin is `cloud`.** Memory files, native session names, subagent linkage
  and the board listener are not available for Grok Bot.

A session is the hook's `conversation_id` (or `session_id`). Grok Bot is in beta,
and some runtimes have been reported to emit only the tool hooks and leave those
IDs blank. Capture then records tool activity only and groups it into one
activity log per workspace and UTC day, named `Grok Bot activity in <workspace>
on <date>`; this keeps the work searchable without presenting it as a
conversation. `opencrawl collect status --json` on the Bot's computer shows what
actually arrives. The hook contract here follows Cursor's published hook
reference; confirm it on your own Bot computer before relying on coverage.

Enterprise teams can prepare every member's computer with a Team Setup manifest
that carries no credential:

```json
{
  "manifestId": "opencrawl-capture",
  "entries": [{
    "id": "install-opencrawl-capture",
    "setup": "#!/bin/sh\nset -eu\nnpm install --prefix \"$HOME/.local/share/opencrawl\" --no-audit --no-fund @getopencrawl/cli@next\nOPENCRAWL_NO_UPDATE=1 \"$HOME/.local/share/opencrawl/node_modules/.bin/opencrawl\" collect install --yes --harness grok-bot --defer-auth --api https://your-opencrawl.example --json"
  }]
}
```

Team Setup reruns the script when a computer starts and about daily, which also
keeps the CLI current; installation is idempotent and keeps an identity that is
already bound. `--defer-auth` installs the hooks without identifying anyone. Each member then
signs in on their own computer (`opencrawl login --no-browser`), and the next
hook binds that identity before anything is uploaded. Do not distribute one
`OPENCRAWL_SESSIONS_TOKEN` as a Team Secret: an upload credential belongs to one
person, so every member's sessions would be attributed to its owner.

## Contents and identity

Batches include deployment-derived user/tenant identity, stable installation ID, native session ID, harness, hostname, timestamps, byte ordering, native message/parent IDs, tool call IDs, and available parent-session/agent IDs. Origin is CLI, desktop, subagent, or unknown, with native evidence retained. Explicit Codex CLI/exec source takes precedence over an inherited desktop originator. Claude sdk-cli is CLI. Unknown origin remains explicit.

User and assistant messages, tool inputs/results, attachment records, available reasoning summaries, compaction boundaries and selected runtime metadata are retained. Repeated system/developer prompts and encrypted reasoning are excluded. Inline attachment bytes and referenced local image/file bytes are stored by SHA-256; batches refer to those blobs. Missing, remote-only and over-limit attachments have explicit statuses. Remote URLs are retained without fetching them.

Uploads are limited to 16 MiB per batch and 32 MiB per attachment. Oversized transcript records remain locally pending and surface in status. This captures what the harness persists or provides to its hooks; it is not an inference proxy and cannot recover omitted or truncated native records, cloud-only sessions, or deleted attachment files.

An event ID is immutable within the environment prefix, tenant, uploading user,
harness, installation and session. Every field of the accepted event JSON is part
of its identity. Object property order is ignored; array order is significant.
Repeating the same event is safe, including inside differently grouped batches.
Changing its data, timestamp, kind, sequence or any other event field returns
HTTP 409. Use a new event ID for a new event. The CLI derives versioned IDs from
the native record/notice identity and final normalized event JSON, after attachment
extraction. Existing queued batches keep their old IDs and bytes; the identity
upgrade does not reset cursors or import history. Explicit replay of records
accepted under the earlier raw-record ID format can create one-time duplicates;
see the CLI README for the compatibility boundary. Batch metadata such as upload origin is outside
the event identity; it does not change event chunk contents.

Before publishing a raw batch, capture atomically reserves all its event IDs in
a conditional per-session ledger. A conflict rejects the entire batch without
reserving its other IDs. A source-write failure after reservation leaves those
IDs reserved but does **not** mean the batch was accepted: retry identical event
content until the durable receipt arrives. Reservations are never automatically
released because a lost acknowledgement may conceal a successful source write.
Each ledger is capped at 16 MiB (about 125,000 distinct IDs); a batch that exceeds
capacity fails with HTTP 413 before publication. Start a new session to continue.
Concurrent writers use storage compare-and-set; exhausted contention returns 503
and clients retry the same batch.

Installation enrolls new sessions and existing sessions modified afterward. Existing active transcripts are read from the beginning on first encounter. It does not automatically import inactive historical sessions. Setup offers an optional one-time history import: terminal users choose Claude Code, Codex, both, or skip; noninteractive/JSON installs return a decision for the agent to ask the user. `collect backfill --dry-run --json` previews file counts without reading transcript content or contacting a server. After explicit user approval, `collect backfill --harness claude-code|codex|all --yes` imports the selected local stores, including desktop coding, host-mirrored Claude Desktop `.claude/projects` histories and subagents, and archived Codex sessions, through the same authenticated capture pipeline. `collect install --backfill skip` skips history. A repeat import resumes existing cursors; it never enables recurring history import. Claude Desktop mirrors are discovered only within native runtime directories under its `local-agent-mode-sessions` application-data store. Messages in each runtime’s audit log are preserved when their native UUID is absent from its project transcripts; duplicate audit copies and transport bookkeeping are skipped. Audit messages retain their individual session IDs and timestamps. Cloud-only chats and records available only inside a VM remain outside this local transcript importer.

## Reliability and control

`opencrawl collect status --json` shows the last authenticated identity, installation, pending batches, last receipt and last error. `collect sync` reconciles transcripts and uploads; `collect flush` processes pending hook notices and known transcript tails, then waits for queued batches to receive durable acknowledgements. `collect uninstall` stops collection and removes only OpenCrawl's hooks; it preserves queued data. Explicit flush remains available after uninstall.

The collector persists batches before advancing cursors, holds incomplete trailing JSONL lines, and deletes batches only after a matching durable receipt. Repeated transcript records have stable IDs; hook/transcript duplicates remain available for downstream deduplication. Enrollment and queued records stay pinned to their original team and human author. A changed login rejects uploads before any attachment bytes are sent. Sign back into the original destination, or uninstall and explicitly resolve/purge pending data before reinstalling for another destination. Rejected uploads remain queued. The default local spool is `~/.config/opencrawl/capture/`: `queue/` contains pending JSON batches, `blobs/` contains attachment bytes keyed by SHA-256, and `state/` contains transcript cursors. `OPENCRAWL_CONFIG_HOME` takes precedence over `XDG_CONFIG_HOME`; either replaces `~/.config`. Local spool/configuration files are private to the OS user. Unreferenced attachment blobs are reclaimed after a 24-hour grace period.

## Single-tenant deployment

Core owns the shared ingestion protocol and requires an explicit principal and durable store adapter. Domain logic imports no WorkOS or AWS code. Both hosted and self-hosted receivers use the same S3-compatible adapter and object format. The runnable single-tenant receiver requires an existing bucket; it checks access before listening and has no filesystem fallback:

```sh
export OPENCRAWL_SESSIONS_TOKEN="$(openssl rand -hex 32)"
export OPENCRAWL_LANDING_S3_BUCKET=opencrawl
export OPENCRAWL_LANDING_S3_REGION=us-east-1
export OPENCRAWL_LANDING_S3_ENDPOINT=http://127.0.0.1:8333 # omit for AWS S3
export OPENCRAWL_LANDING_S3_ACCESS_KEY_ID=your-access-key
export OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY=your-secret-key
# Defaults to sessions/self-hosted/v1:
export OPENCRAWL_LANDING_S3_PATH=sessions/self-hosted/v1
export OPENCRAWL_USER_ID=owner
export OPENCRAWL_USER_NAME="Your name"
npm run sessions
# In the CLI environment, with the same receiver token:
opencrawl collect install --api http://localhost:8093
```

The receiver defaults to loopback. Use HTTPS when exposing it remotely. The CLI securely saves the receiver token for later hook/background uploads. The operator-configured identity defines the sole tenant/owner; the uploaded body cannot change it. Storage persists in the bucket across receiver restarts. Set the endpoint to your MinIO, SeaweedFS, or other S3-compatible service. For a local stack with object storage, follow [self-hosting](self-host.md). AWS role credentials are supported when explicit keys are omitted. Other deployments can supply their own authentication adapter.

## Hosted deployment

The hosted shell verifies the OAuth token and fresh verified WorkOS user. Every data-bearing request requires current active organization membership. Missing or ambiguous team selection must be completed before capture; there is no personal tenant fallback. The shared core enforces the resulting neutral principal. Each environment, tenant and user has a separate object prefix; attachment deduplication is scoped to that owner. The shell supplies the S3 adapter and deployment configuration. No WorkOS account or AWS service is required for the single-tenant offering; a compatible object store is required.

The HTTP protocol provides identity, attachment upload, immutable batch upload and receipt-based batch readback under /api/sessions/. Every team member can search and read the team's captured sessions. Receipt readback accepts `userId` to select the author inside the authenticated tenant, while uploads must match the authenticated human. Stored records preserve that human's ID, name and email.

## Persistence, backup and versioning

Back up the configured bucket/prefix using the object store's versioning, replication or backup tooling. Restore with the same configured prefix and tenant/user identity; receipt readback verifies the restored records. Preserve the receiver token and storage credentials separately. Never merge backups belonging to different configured owners.

Both deployments write `<prefix>/tenants/<tenant-hash>/users/<user-hash>/<harness>/<installation-hash>/<session-hash>/<batch-hash>.json.gz` and owner-scoped `attachments/<sha256>` objects. The session directory also contains `event-identities-v1.json`, a versioned conditional ledger of hashed event IDs and canonical content hashes. Back up and restore ledgers together with raw objects; retained failed-upload reservations remain authoritative. A downstream OpenSearch ingester uses one S3 reader and one batch schema, configured with the endpoint/bucket/prefix. The shared OpenSearch ingester and authenticated search API are documented in `session-indexing.md`. The laptop spool remains local and is only a retry buffer.

Upgrading the former filesystem receiver: stop it, copy the contents under `capture-v1/` into the target S3 prefix without changing relative object keys, verify attachment hashes and receipt readback, then start this receiver with the S3 configuration. Keep the original directory as a rollback backup until verification finishes. `OPENCRAWL_SESSION_DIRECTORY` now fails startup explicitly; local storage is retained only as an internal test helper.

Schema version 1 retains immutable batches and attachment objects. Upgrading a
receiver without event-ID enforcement requires the audit and activation procedure
in `session-indexing.md`; do not overlap old writers with the first ledger
bootstrap. Keep existing objects and ledgers when upgrading or rolling back.
A binary without the capture API cannot serve these records, but does not erase
them. Before downgrading the CLI to a version without capture, run collect
uninstall to remove its hooks and scheduler. Hosted object lifecycle and backups
remain the operator's responsibility.

Revocation is checked at upload/read time. Queued background uploads re-authenticate and require the originally enrolled team and author. Hosted organization membership is checked on every request; removing membership rejects subsequent requests. Existing valid OAuth access tokens retain their ordinary token lifetime, while a failed refresh stops later uploads. Local collection continues until uninstall; failed uploads remain queued.

## Worker lifecycle and delivery boundaries

A notice is atomic and durable before a hook returns. Attachment bytes and immutable
batches are durable before the transcript cursor advances. A retry resends the same
batch bytes; a lost acknowledgement does not reread a larger growing transcript into
that batch. The worker uses nonblocking SQLite transaction ownership (bundled in the CLI runtime, with no service); foreground flush/backfill waits
for upload ownership without the old 20-second SESSION_BUSY deadline. It releases
worker ownership before checking for notices arriving during shutdown.

Known sources remain enrolled across worker exits. The worker polls for 30 seconds
after activity, so a Stop hook is not treated as a transcript completion fence. New
hooks and explicit sync/flush recheck those sources. Transient failures retry
with backoff while the process lives; source files, notices and queued batches survive
process loss. This is eventual delivery given retained data, future execution and
an accepting network endpoint, not a guarantee after permanent sandbox destruction.
Partial JSONL records remain in the source until complete. Existing content filtering,
history consent and server authorization rules continue to apply.

Session names come from Claude Code's native `custom-title`/`ai-title` records and
Codex's `session_index.jsonl`, including renames. The library uses these names in
both the list and viewer; absent a name, it falls back to original user message
text, excluding injected context and transport fields. `opencrawl collect titles`
refreshes names only for sessions with existing capture cursors. It keeps the
enrolled destination and exclusions and does not import additional conversations
or replay message events. A machine without the original name metadata retains
the message fallback until the capturing client supplies a name.

Cloud image setup prepares hooks with --defer-auth and --backfill skip without
runtime secrets. Authentication and the per-runtime installation ID are established
by the first harness-managed async hook before capture. The agent does not wait for authentication.
