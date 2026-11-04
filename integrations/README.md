# Integrations

Connects a self-hosted OpenCrawl to the context people already have: the data in
their tools (Google Drive, Notion, Slack, GitHub, databases, and more) and the
transcripts of the agent sessions they run. Both land in the same S3 bucket, so
their agents can search all of it through one index.

```
 data sources ──► Airbyte (self-hosted) ──► S3 bucket ──────────┬──► OpenCrawl indexer ──► search / MCP
  Drive, Notion,   auth, sync schedules,     <path>/<source>/    │    (not built yet)
  Slack, DBs ...   600 connectors                                │
                                                                 │
 agent sessions ─► collector ─► receiver ──► S3 bucket ──────────┘
  Claude Code,      hourly sync  HTTP + MCP  <path>/agent-sessions/
  Codex, ChatGPT    per machine
```

| Directory | Status |
| --- | --- |
| [`airbyte/`](airbyte/README.md) | Working: local install, production Helm values, source sign-in, S3 landing, sync CLI |
| [`agent-sessions/`](agent-sessions/README.md) | Working: Claude Code, Codex and Gemini CLI capture, ChatGPT and Claude.ai exports, MCP, S3 landing |

This directory is operator tooling: scripts, deployment config and small API
clients. It is not part of the published `@1patch/opencrawl-core` package, and
`src/` does not import it. Like the core, it has no npm dependencies. When the
indexer needs to read landed records, add that interface to the core then.

## Why Airbyte

- It is the only open option with broad coverage: about 600 source connectors,
  including OAuth sign-in, incremental sync, schedules and retries.
- Users run it themselves. Their tokens and data stay on their infrastructure,
  with no OpenCrawl or third-party account in the path.
- A public API covers sources, destinations, connections and jobs, so OpenCrawl
  can drive it without users touching the Airbyte UI.

## Licensing

Airbyte's platform and most of its connectors use the
[Elastic License 2.0](https://docs.airbyte.com/platform/developer-guides/licenses/),
not an OSI license. The Airbyte Protocol and Python CDK are MIT. Nothing here
vendors or redistributes Airbyte code. These scripts install Airbyte's own
releases, and users run Airbyte under its license on their own infrastructure.

ELv2 forbids offering Airbyte to third parties as a hosted or managed service.
Self-hosted OpenCrawl calling the user's own Airbyte is fine. A hosted OpenCrawl
that exposes Airbyte's connector catalog as a self-serve feature is close to
what the license prohibits. Get a commercial agreement or legal review before
doing that.
