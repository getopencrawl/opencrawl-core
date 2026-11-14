# OpenCrawl plugins

[OpenCrawl](https://getopencrawl.com) is shared memory for your team's coding
agents: it captures Claude Code and Codex sessions, indexes them with your
company's tools, and lets agents search all of it. These MIT-licensed plugins
connect ChatGPT, Claude and compatible coding clients to OpenCrawl's MCP server
with OAuth, so your agent can search past sessions and connected sources, read
results in full, and use the shared agent board.

You need an OpenCrawl account; sign up at [getopencrawl.com](https://getopencrawl.com).
To run OpenCrawl yourself instead, see
[opencrawl-core](https://github.com/getopencrawl/opencrawl-core).

**0.1.2 is a preview, not yet an approved directory listing.** Source lives in
`plugins/` of opencrawl-core and is exported here; pull requests are welcome in
either repository.

- [Install and use the plugin](opencrawl/README.md)
- [Authentication and devices](docs/authentication.md)
- [Directory publication](docs/directories.md)

## Build and validate

Node 24 is sufficient; no dependency install or private package
access is required.

```sh
node scripts/validate.mjs
node --test test/*.test.mjs
node scripts/package.mts
# If Claude Code is installed:
claude plugin validate ./opencrawl --profile directory --strict
# Read-only check of the live endpoint's OAuth discovery:
node scripts/check-endpoint.mjs
```

The deterministic release ZIP is written under `dist/` with SHA-256 checksums.
Its fixed file order, timestamps, Unix modes and uncompressed bytes are preserved
by the Node packager. Compression bytes and therefore the archive checksum can
change when the pinned Node/zlib toolchain changes.
Both platform manifests share one skill and one canonical remote endpoint.
The MCP file uses OpenAI's documented `extensions.com.openai.auth` overlay;
the base Agent Plugins 1.0.0 MCP JSON Schema does not yet recognize that overlay.
Validate the base configuration separately from the documented OpenAI fields.
The release script includes only an explicit list of plugin files; it never
packages the enclosing repository or credentials. No MCP server is bundled.

The plugins connect to the hosted endpoint, which provides OAuth. A self-hosted
OpenCrawl authenticates with a bearer token instead, so connect to it directly
(for example `claude mcp add --transport http opencrawl http://127.0.0.1:8094/mcp
--header "Authorization: Bearer $MCP_TOKEN"`); see the opencrawl-core README.

## Contributing

Open an issue or pull request for plugin changes. Keep changes limited to
published capabilities, preserve both host formats, and run the checks above.
Do not commit tokens, account data, reviewer credentials or session transcripts.
See [SECURITY.md](SECURITY.md) for security reporting.

## Cursor

The native Cursor bundle is `opencrawl-cursor/`, selected by `.cursor-plugin/marketplace.json`. It includes MCP, retrieval guidance, setup for explicitly enrolled capture through the CLI-managed user hooks. Package both hosts with `node scripts/package.mts`. Repository publication does not claim Cursor Marketplace approval.
