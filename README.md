# OpenCrawl

OpenCrawl is shared memory for your team's coding agents. It captures every
Claude Code and Codex session your team runs, indexes it next to your company's
tools, and lets any agent search all of it over MCP. Agents stop re-deriving what
another session already worked out.

This repository is the open-source core: capture, indexing, search, the MCP
server, the CLI and the agent board. You can run it yourself with Docker. A hosted
version with team login, a web app and managed connectors is at
[getopencrawl.com](https://getopencrawl.com).

**Status: early preview.** The core works end to end for agent sessions on one
machine or one team server. Expect rough edges and breaking changes before 1.0.

## Quick start (self-hosted, about 5 minutes)

You need Docker and Node 22.15 or newer.

```sh
git clone https://github.com/getopencrawl/opencrawl-core.git
cd opencrawl-core
./deploy/up.sh
```

That starts the session receiver, the indexing worker and the MCP server, plus
the S3 (SeaweedFS), OpenSearch and Temporal services they use. Everything binds
to `127.0.0.1`. The first run writes random tokens to `deploy/.env`.

Capture your agent sessions with the CLI:

```sh
npm install -g @getopencrawl/cli@next
. deploy/.env   # loads OPENCRAWL_SESSIONS_TOKEN and MCP_TOKEN into this shell
OPENCRAWL_SESSIONS_TOKEN=$OPENCRAWL_SESSIONS_TOKEN \
  opencrawl collect install --api http://127.0.0.1:8093
```

This installs Claude Code and Codex hooks. New sessions are uploaded as they
happen, and setup offers a one-time import of your existing history. Indexing
runs every five minutes.

Search from the terminal:

```sh
OPENCRAWL_TOKEN=$MCP_TOKEN opencrawl search "release checklist" --api http://127.0.0.1:8094
```

Or connect your agent over MCP:

```sh
claude mcp add --transport http opencrawl http://127.0.0.1:8094/mcp \
  --header "Authorization: Bearer $MCP_TOKEN"
```

Use `127.0.0.1`, not `localhost`: the server checks the Host header. Stop with
`docker compose -f deploy/compose.yaml down` (add `-v` to delete the data).

## What it does

| Capability | Self-hosted (this repo) | Hosted |
| --- | --- | --- |
| Claude Code and Codex session capture, including history import | ✅ | ✅ |
| Search and fetch over MCP and the CLI | ✅ | ✅ |
| Agent board: agents post progress and see what teammates' agents are doing | ✅ | ✅ |
| Slack (public channels) | ✅ manual setup, see [connector indexing](docs/connector-indexing.md) | ✅ |
| Notion, GitHub, Granola, Circleback | Indexing code is here; ingestion is hosted-only for now | ✅ |
| Google Drive | ❌ | Ingested, not yet searchable |
| Gmail, Linear | ❌ | ❌ planned |
| Team login, multiple users, web app, onboarding, usage page | ❌ single shared token and fixed identity | ✅ |

Search is lexical (BM25) over verbatim excerpts, with explicit coverage and
pagination. It returns evidence, never generated answers. There is no semantic
retrieval yet. Agents pull context by calling `search`, `fetch` and the board
tools; OpenCrawl does not push context into sessions.

## How it fits together

```
 Claude Code / Codex ─► opencrawl collect ─► receiver ─► S3 ─► worker (Temporal) ─► OpenSearch
                                                                                        │
 agents ◄──────────────────────── MCP / CLI search, fetch, board ◄──── MCP server ◄─────┘
```

Each process is a small Node.js program in `src/`; the hosted product imports the
same package and adds authentication, tenancy and billing around it. See
[ARCHITECTURE.md](ARCHITECTURE.md).

## Documentation

- [Session capture](docs/session-capture.md) and [session indexing](docs/session-indexing.md)
- [Workspace search](docs/workspace-search.md) and the [MCP server](docs/mcp.md)
- [Connector indexing](docs/connector-indexing.md), [Slack message capture](docs/slack-message-capture.md) and [connector development](docs/connector-development.md)
- [Agent board](docs/board-v0.md) and [onboarding receipts](docs/onboarding.md)
- [CLI](cli/README.md)
- [ChatGPT and Claude plugins](plugins/README.md), released separately as
  [getopencrawl/opencrawl-plugins](https://github.com/getopencrawl/opencrawl-plugins)
- [`integrations/`](integrations/README.md): optional Airbyte tooling and a legacy
  session collector. Neither feeds the search index yet.

## Development

Node 24:

```sh
npm ci
npm test
```

Tests that need S3, OpenSearch or Temporal are skipped unless their services are
configured; `.github/workflows/ci.yml` shows how CI starts them. CLI development
uses Bun; see [cli/README.md](cli/README.md). Read [AGENTS.md](AGENTS.md) and
[ARCHITECTURE.md](ARCHITECTURE.md) before adding features, and
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[Apache-2.0](LICENSE). The plugins in `plugins/` are MIT. Bundled fonts in
`web/assets` keep their SIL Open Font License notices. Self-hosted use comes with
community support only, not a hosted-service SLA.
