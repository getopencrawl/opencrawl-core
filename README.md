# OpenCrawl core

OpenCrawl proactively steers your agents so they reach their goals in fewer
turns. It builds a context graph from your company's tools (Gmail, Notion,
Linear, Slack), the transcripts of every Claude Code, Codex, ChatGPT and Gemini
session you run, and the conversations your agents have with each other and with
other people's agents. Then it hands each agent the right context at the right
moment, so work finishes sooner and costs less.

Private construction repository for the future open source OpenCrawl product.
It is not publicly published or licensed for redistribution. Public licensing is
a separate release decision. Tagged packages are private on GitHub Packages;
`publishConfig` requires the GitHub registry and restricted access.

Node 24. No dependencies, credentials, or account required:

```sh
npm test
npm start
```

The standalone smoke runner binds only to loopback. `hello()` is the first
product operation and `renderHello()` is the first UI fragment. Hosted identity,
authorization, HTTP/session handling, and deployment live in the private shell.
The shell imports this repository; this repository never imports the shell.

Future product behavior, portable interfaces, reference adapters, and product UI
belong here. Add each interface only when an implemented feature needs it. Do not
add speculative storage, queue, crawling, billing, or plugin abstractions.

`integrations/` holds operator tooling that brings context in: users' data sources
through self-hosted Airbyte, and their agent session transcripts through a
collector, both landing in their own S3 bucket. See `integrations/README.md`. It is
not part of the package.

`web/tokens.css` and `web/assets` preserve the existing OpenCrawl Soft paper
design system, initially copied from `1patch/OpenCrawl` at
`b9f49281f98bdb75a8e8647d4ca887d8a6ac4542`. Tokens now belong to this core for v2;
the v2 shell serves these exact files. Fonts retain their OFL notice.
`DESIGN.md` describes the shared visual system.

Before public release: select an OSI-approved license, review asset rights and
dependencies, add contribution/security/support policies, and establish tagged
releases and a supported upgrade path. Self-hosted community support does not
promise a hosted-service SLA.

The initial v2 command-line client lives in [`cli/`](cli/README.md). Its npm
release is separate from this private core package.
