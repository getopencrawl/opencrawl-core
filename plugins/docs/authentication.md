# Authentication across devices

Use a remote HTTPS MCP connection with OAuth, PKCE and refresh tokens. The host
is the OAuth client, OpenCrawl's authorization service issues the grant, and the
MCP server verifies tokens and resource access. The hosted identity adapter stays
outside these portable packages. There are no bundled API keys or per-machine
OpenCrawl login scripts.

Claude's remote connectors are brokered through the Claude account from
Anthropic's servers across web, Desktop, mobile and Cowork. Those clients share
the hosted callback. Claude Code can use its own OAuth client and loopback
callback. Do not promise that a local CLI automatically inherits the cloud grant.

ChatGPT acts as the OAuth client and manages the connected service authorization.
The intended experience is initial account linking followed by host-managed token
refresh, not OpenCrawl login on every device. Actual availability depends on the
host surface and workspace policy. Verify a second device under the same account
and workspace before claiming cross-device acceptance. Codex/local MCP clients
may use separate authorization; GitHub installation alone does not transfer tokens.

Users connect separately in ChatGPT and Claude. Refresh-token expiration,
revocation, changed scopes or workspace/account changes can require reconnection.
Ordinary OAuth does not make OpenAI or Anthropic the OpenCrawl identity provider.
It still needs initial OpenCrawl authentication and consent.

OpenAI's separate Sign in with ChatGPT plugin flow could identify or provision an
OpenCrawl user from a verified OpenAI ID token. As checked on 2026-11-04, this is a
limited commercial-partner trial requiring access/client registration. It is not
enabled by this release. Never treat `login_hint`, a model-provided email, or a
client ID as proof of the user's identity. The cited Claude integration uses
OpenCrawl OAuth; this release does not implement a Sign in with Claude identity flow.

## Host configuration

The portable MCP manifest prefers CIMD (with the documented DCR fallback), requires
OAuth, and requests `offline_access` for refresh. The Claude manifest leaves OAuth
discovery to Claude. Both use exactly `https://app.getopencrawl.com/mcp`.
No token, secret, fixed client ID, or identity-provider endpoint is embedded.

## Acceptance before claiming the experience works

- Discover protected-resource metadata, exact resource audience, authorization
  server, S256 PKCE and CIMD/DCR; require 401 with a discovery challenge when unauthenticated.
- Complete each platform's consent flow and invoke `test_connection` successfully.
- Reopen on a second device signed into the same platform account/workspace and
  confirm the tool works without a new OpenCrawl login.
- Exercise expiry/refresh and revocation; verify invalid, wrong-audience and
  revoked tokens cannot call tools. A package check or discovery probe alone
  does not verify these behaviors.

Sources checked 2026-11-04:
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/siwc/chatgpt-plugin
- https://developers.openai.com/siwc/request-client-id
- https://claude.com/docs/connectors/building/authentication
- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
