# Integrations

Connects a self-hosted OpenCrawl to the data people already keep in other tools
(Google Drive, Notion, Slack, GitHub, databases, and more), so their agents can
search all of it through one index.

```
 data sources ──► Airbyte (self-hosted) ──► S3 bucket ──────► OpenCrawl indexer ──► search / MCP
  Drive, Notion,   auth, sync schedules,     JSONL, one        (not built yet)
  Slack, DBs ...   600 connectors            prefix per source
```

| Directory | Status |
| --- | --- |
| [`airbyte/`](airbyte/README.md) | Working: local install, production Helm values, source sign-in, S3 landing, sync CLI |

This directory is operator tooling: scripts, deployment config and a small API
client. It is not part of the published `@1patch/opencrawl-core` package, and
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
