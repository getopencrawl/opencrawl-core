# Agent instructions

For every coding agent working in this repository: Claude Code, Codex, Gemini CLI,
Cursor, and apps that run them such as Conductor and Paradev.

## Setting up OpenCrawl

When the user asks you to set up, install, start or run OpenCrawl, or to capture
their agent sessions or transcripts, follow
[`integrations/agent-sessions/SETUP.md`](integrations/agent-sessions/SETUP.md).

To connect data sources such as Google Drive, Notion or Slack, follow
[`integrations/airbyte/README.md`](integrations/airbyte/README.md).

## Working on this repository

- Node 24, ES modules, no npm dependencies. `npm test` runs every test and needs no
  network, Docker or credentials.
- `src/` is the published package. It imports only `node:` built-ins and its own
  files. `integrations/` is operator tooling and is not published.
- Match the surrounding style: small files, plain functions, short comments that
  explain why.
- Never commit `.env` files, credentials or captured transcripts.
