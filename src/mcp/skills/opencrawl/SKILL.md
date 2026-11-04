---
name: opencrawl
description: Understand OpenCrawl, its product direction and available services, and verify an authenticated connection before using its MCP tools.
---

# OpenCrawl

OpenCrawl is building a portable knowledge and context platform: capture source
material, organize it, and make it useful to people and AI agents. Its product
core runs independently of the managed hosted service; the hosted service adds
managed operation and account access.

Available today: account authentication, CLI enrollment, and agent-session
capture through the separate CLI and session API. This MCP connection currently
provides this overview and the read-only `test_connection` tool. It does not
expose captured sessions or provide crawling, indexing, search, or retrieval.
Describe those as product direction, not currently callable services.

Use `test_connection` when asked to confirm connectivity. Report success only
after the server returns `connected: true`; include its server time if useful.
That result verifies this authenticated MCP request reached the server. It does
not test unrelated services, data ingestion, or search quality.

Discover tools before attempting any further operation. Never invent unavailable
tools or claim that a successful connection grants access to user data. Let the
MCP client handle sign-in and authorization; never ask for passwords, access
tokens, or refresh tokens in chat.
