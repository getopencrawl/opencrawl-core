# OpenCrawl core

OpenCrawl proactively steers your agents so they reach their goals in fewer
turns. It builds a context graph from your company's tools (Gmail, Notion,
Linear, Slack), the transcripts of every Claude Code, Codex, ChatGPT and Gemini
session you run, and the conversations your agents have with each other and with
other people's agents. Then it hands each agent the right context at the right
moment, so work finishes sooner and costs less.

Private construction repository for the future open source OpenCrawl product.
The runtime is not publicly published or licensed for redistribution. Public
runtime licensing is a separate release decision. The plugin-only exception is
documented below. Tagged packages are private on GitHub Packages;
`publishConfig` requires the GitHub registry and restricted access.

Node 24. No dependencies, credentials, or account required:

```sh
npm test
npm start
```

The standalone smoke runner binds only to loopback. `hello()` is the first
product operation and `renderHello()` is the first UI fragment. This is not yet
a complete self-hosted product. Hosted WorkOS authentication, tenant membership,
multitenancy and managed deployment live in the private shell. Resource
authorization and a usable single-tenant runtime belong here. The shell imports
this repository; this repository never imports the shell. Read
[`ARCHITECTURE.md`](ARCHITECTURE.md) and `AGENTS.md` before adding features.

Future product behavior, portable interfaces, reference adapters, and product UI
belong here. Add each interface only when an implemented feature needs it. Do not
add speculative storage, queue, crawling, billing, or plugin abstractions.

`integrations/` holds operator tooling that brings context in: users' data sources
through self-hosted Airbyte, and their agent session transcripts through a
collector, both landing in their own S3 bucket. See `integrations/README.md`. It is
not part of the package.

`web/tokens.css`, `web/frame.css`, `web/controls.css` and `web/assets` hold the
OpenCrawl Night design system, matching getopencrawl.com (see `DESIGN.md`).
Tokens belong to this core for v2; the v2 shell serves these exact files. Fonts retain their OFL notice.
`DESIGN.md` describes the shared visual system.

Before public release: select an OSI-approved license, review asset rights and
dependencies, add contribution/security/support policies, and establish tagged
releases and a supported upgrade path. Self-hosted community support does not
promise a hosted-service SLA.

The initial v2 command-line client lives in [`cli/`](cli/README.md). Its npm
release is separate from this private core package.

The independently released [ChatGPT and Claude plugins](plugins/README.md) are
MIT licensed under `plugins/LICENSE`; this exception does not relicense or
make the rest of core public. See [plugin release boundaries](docs/PLUGIN-RELEASE.md).

## Onboarding receipts

The portable onboarding page polls an authenticated GET /api/onboarding.
createOnboardingStatus from @1patch/opencrawl-core/onboarding/status stores
three independent milestones under the configured session prefix and trusted
tenant/user scope: CLI authentication observed, authenticated MCP exchange
observed, and session batch durably accepted. Each includes observedAt;
this is historical setup evidence, not a promise that a device remains online or
credentials have not since been revoked. No session text, tokens, emails or
client-supplied owner names enter these receipts.

The single-tenant capture receiver supplies this endpoint under the same operator
token and configured principal as capture. GET /api/sessions/identity records
CLI authentication; accepted uploads record session receipt. An independently
constructed MCP runtime can use the same store/prefix and pass status.mcp as
createOpenCrawlMcp({onAuthenticated}) with the same trusted tenant/user principal.
This hook is a best-effort observation after the authenticated exchange, never an
authorization gate. A receipt error or timeout preserves the original tool
response, including an already committed board write. Normal receipts are
awaited for up to `observationTimeoutMs` (default 1000, range 1–10000 ms); a timed
out observer may finish later. `onObservationError` receives bounded protocol
metadata only and defaults to a generic log event; its own failure cannot affect
the tool response.
MCP client names are self-reported display metadata, never authorization inputs.
Unknown clients render without a brand. The UI has no simulated success.

For custom browser runtimes, authenticate the status endpoint using the same
principal as capture/MCP and supply displayName from verified account data.
Render renderOnboarding({mcpUrl,setupPrompt,integrationsUrl}) and serve the core
onboarding JS/CSS and controls alongside tokens/assets. The hosted shell supplies
its own login and integrations routes; this UI does not require WorkOS.

## Connector indexing

See the [Slack indexing operation guide](docs/connector-indexing.md) and the
[connector development pattern](docs/connector-development.md) before adding a new
source-to-search adapter. Extraction support alone does not imply indexing support.

## Workspace search

MCP `search` and `opencrawl search` query captured sessions and indexed workspace
connectors with compact excerpts and conservative duplicate grouping. MCP `fetch`
and `opencrawl fetch` expand an indexed passage with fresh access checks.
See [workspace search](docs/workspace-search.md)
for self-host setup, matching modes, coverage, and bounded pagination.
