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

The OSS application uses local Better Auth accounts in one organization. The
first administrator is bootstrapped once; subsequent users require an invitation.
Browser sessions, CLI device login and MCP consent authenticate users, and the
server checks current membership and resource visibility. Admins manage shared
integrations. Private sessions and memories remain accessible only to their owner.

`./dev/up` creates a development installation and prints its local login. It is
not a hardened production deployment. Keep dependency ports private, terminate
TLS before exposing the application, and protect identity, object-store and
backup data. The bundled development OpenSearch disables its security plugin.
See [self-hosting](docs/self-host.md) for configuration and account recovery.

The separate capture-only stack uses static bearer tokens; holders share that
token's configured identity. Do not confuse that smoke stack with the multi-user
application or expose its dependencies publicly.
