# Security

Report vulnerabilities through this repository's
[GitHub private vulnerability reporting](https://github.com/getopencrawl/opencrawl-core/security/advisories/new).
If that form is unavailable, ask a maintainer for a private reporting channel
without including vulnerability details. Private vulnerability reporting must be
enabled when the repository becomes public; GitHub does not offer it for private repositories.
Do not put vulnerability details, credentials, personal data or session
transcripts in public issues or pull requests.

Include the affected version or commit, the component (receiver, worker, MCP
server, CLI, connector), steps to reproduce and the impact you observed.

## Supported versions

OpenCrawl is a pre-1.0 preview. Fixes land on `main` and in the next CLI and core
releases; older releases are not patched.

## Deployment notes

The self-hosted servers bind to `127.0.0.1` and authenticate every request with
a bearer token from `deploy/.env`. Put them behind your own TLS and authentication
before exposing them on a network. The bundled OpenSearch runs without its
security plugin and must not be published outside the compose network. Every
holder of the MCP token can read every captured session in the deployment.
