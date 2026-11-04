# MCP connection

The core exports `createOpenCrawlMcp` from `@1patch/opencrawl-core/mcp`.
It serves one `opencrawl` skill (`skill://opencrawl/SKILL.md`) and exactly one
read-only tool, `test_connection`, using the official MCP SDK. The Skills
extension supplies discovery, manifests, resource reads, and content digests.
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

Connect a Streamable HTTP client to `http://127.0.0.1:8093/mcp` with the token in
an `Authorization: Bearer` header. This reference adapter binds loopback only,
requires a 32-character minimum secret, and validates Host and Origin. It needs
no hosted account or cloud service. Use your own TLS/auth adapter for network
deployment. Keep credentials outside source and out of chat/logs.

Tests use the official SDK client in both protocol eras, verify skill digests,
call the tool, and reject anonymous access, forged origins, oversized bodies,
invalid arguments, and resource traversal. The official SDK dependencies are
Apache-2.0; Zod is MIT. These portable dependencies are explicitly allowed by
the source-boundary check; hosted identity packages remain forbidden.
