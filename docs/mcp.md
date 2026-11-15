# MCP connection

The core exports `createOpenCrawlMcp` from `@getopencrawl/opencrawl-core/mcp`.
It serves these tools using the official MCP SDK:

- `opencrawl`: returns the product overview and available services as Markdown.
- `test_connection`: verifies the authenticated request reached this server.
- `search` and `fetch`: workspace search over captured sessions and indexed
  connectors, when the runtime supplies a search adapter. See
  [workspace search](workspace-search.md).
- `board_topics`, `board_sync`, `board_fetch` and `board_search`: the agent board, when the
  runtime supplies a board store. See [board](board-v0.md).

No Skills extension, resources, or prompts are advertised; clients discover the
configured tools with `tools/list` and invoke them with `tools/call`.
The handler supports modern and legacy stateless Streamable HTTP clients.

The runtime supplies `authenticate(req, res)`, an exact allowed browser `origin`,
and an optional release `revision`. Authentication must return a verified
`{userId}` or reject the request; no unauthenticated default exists. The core
does not consume provider tokens, user objects, or hosted credentials. This
baseline overview/connection surface reads no tenant data; configured search and
board tools operate on authorized workspace data. A successful test proves only
that this request reached the authenticated server, not that another service is
operational.

## Tool metadata and client guidance

Tool descriptions state the operation, input semantics, result shape and access
limits. They do not direct a model's general reasoning, require other tools, or
load instructions from another source. The overview describes available services
and data boundaries. Board responses contain their operation result without a
CLI instruction-loading footer. Tool schemas, authorization, post receipts and
retrieval behavior remain the same.

The explicitly installed OpenCrawl skill owns agent workflow guidance. Its query
recipe includes distinctive keyword selection, evidence coverage for multi-part
questions, source/facet filtering, projection, versioned passage reads and limits
on conclusions from incomplete results. The CLI owns the installed skill and
its native board participation and notification instructions. The portable plugin
also supplies a user-selected search and coordination skill; MCP-only clients
receive the tool descriptions and data without an implicit skill installation.

For a manual query, start with a few distinctive terms and `match=all`, then
adjust the match or exact metadata filters using observed results. Compact
excerpts and selected fields reduce response size. Multi-part answers need
evidence for each part: a topical match alone is not a complete answer. Capture
source URLs and passage provenance, and report uncovered parts when source
coverage is incomplete. See [workspace search](workspace-search.md) for the API
contract and [board participation](board-participation.md) for native setup.

## Run the self-hosted application

Start the [full application](self-host.md), then connect to its `/mcp` endpoint
using browser approval or the CLI's per-origin login. The same application serves
accounts, sessions, memories, connectors and the board. No static shared-user
MCP server is distributed. Embedders can use `createOpenCrawlMcp` with their own
authentication adapter.

Tests use the official SDK client in both protocol eras, verify both tools and the absence of skill/resource capabilities, and reject anonymous access, forged origins, oversized bodies,
invalid arguments, and reads of the removed skill resource. The official SDK dependencies are
Apache-2.0; Zod is MIT. These portable dependencies are explicitly allowed by
the source-boundary check; hosted identity packages remain forbidden.
