# Agent sessions

Captures the transcripts of every agent session people run (Claude Code, Codex,
Gemini CLI, ChatGPT, Claude) and lands them in the user's own S3 bucket, for the
OpenCrawl indexer to read.

```
 laptop                                   self-hosted (Docker)
 ~/.claude, ~/.codex, ~/.gemini ─► collector ─► receiver ─► your S3 bucket
 ChatGPT / Claude.ai exports ────► collector ─┘    ▲         AWS S3, or R2, Garage,
 Claude Desktop, Cursor, ... ───────── MCP ────────┘         any S3-compatible store
```

Verified with Claude Code 2.1.305, Codex 0.166.0 and Node 20/22/24, against AWS
S3 and SeaweedFS 4.52.

| File | Purpose |
| --- | --- |
| `local.sh` | Run the receiver on one machine, optionally with a bundled S3 for development |
| `collector.mjs` | Runs on each machine with agents: finds transcripts, uploads new bytes, imports exports, bridges MCP |
| `receiver.mjs` | HTTP API and MCP endpoint that write sessions to the store; serves the collector installer |
| `store.mjs` | Zero-dependency S3 client (Signature V4) |
| `s3-setup.mjs` | Lists, creates and connects the bucket through the user's AWS CLI; JSON output for agents |
| `SETUP.md` | Setup runbook that coding agents follow |
| `compose.yaml` | Receiver, plus SeaweedFS under the `bundled-s3` profile; bound to loopback |
| `.env.example` | Every setting the receiver reads |

## Quickstart

Requires Docker, Node 20 or newer, and an AWS account.

### With your agent

Paste this into Claude Code, Codex, Cursor or any agent with a shell:

> Clone github.com/1patch/opencrawl-core and set up OpenCrawl agent session
> capture as its AGENTS.md describes. Check with me before you create anything in
> my AWS account.

The agent follows [`SETUP.md`](SETUP.md). You sign in to AWS in your browser or
terminal, choose or name the bucket, and approve what it creates.

### By hand

```sh
cd integrations/agent-sessions
node s3-setup.mjs check                         # AWS CLI signed in?
node s3-setup.mjs buckets                       # pick one, or create one:
node s3-setup.mjs create my-opencrawl-bucket --region us-east-1
node s3-setup.mjs connect my-opencrawl-bucket   # IAM user and key, written to .env
./local.sh up
curl -fsSL http://127.0.0.1:7171/install.sh | sh
node ~/.opencrawl/agent-sessions/collector.mjs status
```

With a bucket and key already, copy `.env.example` to `.env`, set the
`OPENCRAWL_LANDING_S3_*` values and skip the `s3-setup.mjs` steps. `local.sh up`
checks that it can reach the bucket and refuses to start otherwise.
No AWS account? `local.sh up --bundled-s3` runs a local S3 (SeaweedFS) for
development and offline use.

The install script downloads the collector to `~/.opencrawl/agent-sessions/` and
runs it as a background service (launchd on macOS, a systemd user unit on Linux).

```
Receiver  http://127.0.0.1:7171 (up)
Machine   my-laptop
Service   running (systemd)
Schedule  every 1h
Last sync incremental, 4.2 MB uploaded, 12 min ago; next in 48 min

Agent        Sessions      Size  Next sync
claude-code        24    227 MB     1.1 MB
codex              13    2.2 GB       0 B
```

## Sync

Like an Airbyte connection: the first sync uploads every existing session, then an
incremental sync runs every hour and uploads only what changed. `install --every
15m` changes the schedule and `collector.mjs sync` syncs now. A restarted collector
keeps its schedule, and a failed sync is retried after five minutes.

## Sources

| Source | How it is captured |
| --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl`, including subagent transcripts; also `CLAUDE_CONFIG_DIR` and per-account `~/.claude-*` directories |
| Codex | `~/.codex/sessions` and `archived_sessions` rollouts; also `CODEX_HOME` and per-account `~/.codex-*` directories |
| Gemini CLI | `~/.gemini/tmp/<project>/chats/session-*.json` |
| ChatGPT | Data export: `collector.mjs import <unzipped export>` |
| Claude.ai | Data export: `collector.mjs import <unzipped export>` |
| Claude Desktop, Cursor, other MCP clients | `save_conversation` MCP tool |

Apps that run these CLIs, such as Conductor, Paradev and IDE extensions, need
nothing extra. Agents on a remote machine, such as a Paradev cloud host, write
transcripts there, so install the collector on that machine too (see "Several
machines").

To add an agent that keeps transcripts on disk, add an entry to `AGENTS` in
`collector.mjs`. Files ending in `.jsonl` are treated as append-only and uploaded
incrementally. Other files are uploaded whole when they change. Agents that keep
history in SQLite (Cursor, OpenCode) need a reader before they can be captured
from disk. Until then, use MCP for them.

Exports are the faithful path for web chat apps. ChatGPT: Settings → Data
controls → Export data. Claude: Settings → Privacy → Export data. Unzip the
archive, then run `import` on the folder. Re-importing a newer export uploads only
the conversations that changed.

## MCP

The receiver serves MCP at `http://127.0.0.1:7171/mcp` (Streamable HTTP). For
clients that only launch local commands, `collector.mjs mcp` bridges stdio to it.

| Tool | Purpose |
| --- | --- |
| `save_conversation` | The agent saves the current conversation; resaving with the same `conversation_id` replaces it |
| `capture_status` | Counts captured sessions by agent and machine |

```sh
claude mcp add --scope user --transport http opencrawl http://127.0.0.1:7171/mcp
codex mcp add opencrawl --url http://127.0.0.1:7171/mcp
```

Claude Desktop (`claude_desktop_config.json`) and Cursor (`~/.cursor/mcp.json`):

```json
{"mcpServers": {"opencrawl": {"command": "node", "args": ["/Users/you/.opencrawl/agent-sessions/collector.mjs", "mcp"]}}}
```

A model rewriting a conversation into a tool call is lossy, and it costs tokens.
Prefer disk capture or exports wherever they exist. Agents captured from disk do
not need the MCP server.

## Storage layout

```
s3://<bucket>/<path>/agent-sessions/<agent>/<machine>/<session>/manifest.json
s3://<bucket>/<path>/agent-sessions/<agent>/<machine>/<session>/<start>-<end>.<jsonl|json>.gz
```

`<path>` is `OPENCRAWL_LANDING_S3_PATH` (default `opencrawl`), the same prefix the
Airbyte S3 landing destination writes under, so one bucket holds everything
OpenCrawl ingests.

Sessions are stored raw, in each agent's native format. Each segment is a gzip of
a byte range of the source file, and the zero-padded offsets in segment names sort
in file order. Concatenating a session's segments reproduces the transcript
exactly. JSONL segments always end on a line boundary, so an indexer can process
each new segment on its own. `manifest.json` records the agent, machine, format,
total length, segment count, source path and timestamps.

Exports land under machine `export`, MCP saves under machine `mcp`.

The receiver accepts a segment only at the offset where the session currently
ends, and offset 0 replaces the session. This makes uploads idempotent and lets
collectors recover on their own. After a crash, a reinstall or a lost local
cache, the collector asks the receiver how much it holds and resumes from there.
A transcript that was rewritten instead of appended to is detected by a tail
checksum and replaced.

## Configuration

**S3.** Sessions go to the bucket in `OPENCRAWL_LANDING_S3_*`; there is no
default bucket. These are the same settings as the Airbyte landing destination
(`integrations/airbyte/.env.example`). The receiver never creates or deletes
buckets. It needs `s3:ListBucket` on the bucket and `s3:GetObject`,
`s3:PutObject` and `s3:DeleteObject` on `<path>/agent-sessions/*`. It deletes only
the segments of a session that is being replaced.

| Setting | Purpose |
| --- | --- |
| `OPENCRAWL_LANDING_S3_BUCKET`, `_REGION`, `_PATH` | Where sessions land |
| `OPENCRAWL_LANDING_S3_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_SESSION_TOKEN` | Credentials. Omit them to use the AWS role where the receiver runs: EC2 instance role, ECS task role, EKS IRSA or Pod Identity |
| `OPENCRAWL_LANDING_S3_ENDPOINT` | Only for S3-compatible stores other than AWS, such as Cloudflare R2 or Garage |

**Several machines.** Each machine with agents needs only the collector. Put one
receiver behind TLS, set `OPENCRAWL_SESSIONS_TOKEN` and
`OPENCRAWL_SESSIONS_PUBLIC_URL`, then run this on each machine. Run it in a
terminal yourself, because the token is a secret and doesn't belong in an agent
chat.

```sh
curl -fsSL https://sessions.example.com/install.sh | OPENCRAWL_SESSIONS_TOKEN=… sh
```

Each machine is stored under its host name; `install --machine <name>` overrides it.

**Privacy.** Transcripts contain whatever passed through the agent, including
file contents, command output and occasionally secrets. They go only to the
receiver you run and the bucket you configure. To skip a project, pass
`--exclude <path fragment>` to `install`. You can repeat the flag.

## Operations

| Task | Command |
| --- | --- |
| Stack status / logs | `local.sh status`, `local.sh logs` |
| Browse captured files | Your bucket, under `<path>/agent-sessions/`; with `--bundled-s3`, http://127.0.0.1:12535 → Files (user `admin`, password `OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY`) |
| Sync now | `collector.mjs sync` |
| Reconcile everything with the receiver | `collector.mjs sync --resync` |
| Collector log | `~/.opencrawl/agent-sessions/collector.log` (macOS), `journalctl --user -u opencrawl-agent-sessions` (Linux) |
| Stop collecting on a machine | `collector.mjs uninstall` |
| Stop the receiver | `local.sh down` |
| Delete the bundled S3's data | `local.sh destroy` (never touches your own bucket) |

Where systemd user services are unavailable (some containers, WSL without
systemd), `install` starts a detached process instead. Rerun `install` after a
reboot.
