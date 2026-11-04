---
name: opencrawl
description: Use when the user asks what OpenCrawl does, how to connect to OpenCrawl, or whether their OpenCrawl connection works.
---

# OpenCrawl

OpenCrawl is building a knowledge and context platform for people and AI agents.
Its direction is to bring source material and agent sessions together and make
relevant context available during work.

This plugin provides an overview and connects to OpenCrawl's remote MCP server.
The initial server contract exposes one read-only tool, `test_connection`.
It does not expose session contents, crawling, indexing, search, or retrieval.
Separate OpenCrawl CLI/session integrations are not installed by this plugin.
Do not present product direction as functionality available through this plugin.

When asked to check the connection:

1. Discover the OpenCrawl MCP tools available in this host.
2. If the host requests authorization, use its built-in OAuth connection flow.
   Never request passwords, API keys, access tokens, or refresh tokens in chat.
3. Call OpenCrawl's `test_connection` with no arguments. The host may prefix its
   name with the server or plugin namespace.
4. Report success only when the tool returns `connected: true`. This proves that
   this authenticated request reached the server, not that any data was ingested
   or that other services work. Include the returned server time if useful.

If the tool is unavailable, say that the connection is not ready and direct the
user to this plugin's connection settings. If authorization fails, ask the user
to reconnect there. Do not loop on login or claim success from installation alone.

The host manages the OAuth grant. ChatGPT and Claude require separate initial
connections. Reconnection can be necessary after revocation, expiry, account or
workspace changes. Local coding clients may manage credentials separately.

Do not read or upload local files, conversation history, credentials, or session
transcripts as part of setup or a connection test. Do not invent additional tools.
