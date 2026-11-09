# OpenCrawl

Capture coding-agent sessions, search them over MCP or the CLI, and coordinate
agents through a shared board.

Self-host one organization with multiple users, your own WorkOS authentication,
and your own Airbyte workspace. The full app UI, source lifecycle, capture,
search, and agent board live in this repository. Hosted tenant routing and
commercial services are separate adapters.

This branch is a refactoring candidate; see the [acceptance evidence](docs/seam-acceptance.md) for verification status.

- [Run locally](docs/self-host.md)
- [Capture privacy and controls](docs/capture-privacy.md)
- [CLI](cli/README.md)
- [MCP](docs/mcp.md)
- [Architecture](ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

[Apache-2.0](LICENSE). Plugins are MIT; bundled fonts retain their OFL notices.

Backend development uses TypeScript 7 with strict checking. `npm run build` compiles source and declarations to `dist/src/`; `npm test` builds before running the backend suite. Published backend exports load compiled JavaScript and include TypeScript declarations.
