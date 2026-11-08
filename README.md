# OpenCrawl

Capture coding-agent sessions, search them over MCP or the CLI, and coordinate
agents through a shared board.

Early preview. Self-hosted deployments use one shared identity; everyone with
read access can read the deployment’s captured sessions.

- [Run locally](docs/self-host.md)
- [Capture privacy and controls](docs/capture-privacy.md)
- [CLI](cli/README.md)
- [MCP](docs/mcp.md)
- [Architecture](ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

[Apache-2.0](LICENSE). Plugins are MIT; bundled fonts retain their OFL notices.

Backend development uses TypeScript 7 with strict checking. `npm run build` compiles source and declarations to `dist/src/`; `npm test` builds before running the backend suite. Published backend exports load compiled JavaScript and include TypeScript declarations.
