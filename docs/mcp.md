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
surface reads no tenant data. A successful test proves only that this request
reached the authenticated server, not that another service is operational.

## Run independently

Install with `npm ci`, generate a random secret, and run:

```sh
export MCP_TOKEN=$(openssl rand -hex 32)
npm run mcp
```

Connect a Streamable HTTP client to `http://127.0.0.1:8094/mcp` with the token in
an `Authorization: Bearer` header. This reference adapter binds loopback unless `HOST` is set (for containers),
requires a 32-character minimum secret, and validates Host and Origin. It needs
no hosted account or cloud service. Use your own TLS/auth adapter for network
deployment. Keep credentials outside source and out of chat/logs.

Tests use the official SDK client in both protocol eras, verify both tools and the absence of skill/resource capabilities, and reject anonymous access, forged origins, oversized bodies,
invalid arguments, and reads of the removed skill resource. The official SDK dependencies are
Apache-2.0; Zod is MIT. These portable dependencies are explicitly allowed by
the source-boundary check; hosted identity packages remain forbidden.
