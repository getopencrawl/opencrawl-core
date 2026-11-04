# OpenCrawl plugins

MIT-licensed plugin packages for ChatGPT, Claude and their compatible coding
clients. Maintained as part of OpenCrawl core, distributed independently so this
repository contains only the public plugin files and release tooling.

**0.1.0 is an integration preview, not an approved directory listing.** It contains
an overview skill and a remote MCP connection. The initial tool is
`test_connection`; it does not provide search, crawling or transcript capture.
The endpoint and your account's access must be ready before tools work.

[Install and use the plugin](opencrawl/README.md) ·
[Authentication and devices](docs/authentication.md) ·
[Directory publication](docs/directories.md)

## Build and validate

Node 24 and Python 3 are sufficient; no dependency install or private package
access is required.

```sh
node scripts/validate.mjs
node --test test/*.test.mjs
python3 scripts/package.py
# If Claude Code is installed:
claude plugin validate ./opencrawl --profile directory --strict
# Read-only live discovery check; intentionally fails while deployment is pending:
node scripts/check-endpoint.mjs
```

The deterministic release ZIP is written under `dist/` with SHA-256 checksums.
Both platform manifests share one skill and one canonical remote endpoint.
The MCP file uses OpenAI's documented `extensions.com.openai.auth` overlay;
the base Agent Plugins 1.0.0 MCP JSON Schema does not yet recognize that overlay.
Validate the base configuration separately from the documented OpenAI fields.
The release script includes only an explicit list of plugin files; it never
packages the enclosing repository or credentials. No MCP server is bundled.

For a self-hosted MCP service, fork the package and change the URL in both MCP
configurations and the OpenAI OAuth `resource` to your HTTPS MCP URL. Your service
must provide compatible OAuth discovery and tools. The distributed configuration
uses the managed OpenCrawl endpoint; MIT licensing does not grant hosted access.

## Contributing

Open an issue or pull request for plugin changes. Keep changes limited to
published capabilities, preserve both host formats, and run the checks above.
Do not commit tokens, account data, reviewer credentials or session transcripts.
See [SECURITY.md](SECURITY.md) for security reporting.
