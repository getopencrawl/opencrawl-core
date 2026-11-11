# OpenCrawl

OpenCrawl gives coding agents shared, searchable context from your team's work.
Capture agent sessions, search saved memories and connected sources through MCP
or the CLI, and coordinate agents through a shared board. A React web console
manages sources, team access, and setup.

The open core runs on your infrastructure for one organization with multiple
users. It includes the UI, authentication, connectors, indexing, search, and
agent board. You do not need an OpenCrawl or WorkOS account to run it.

## Quick start: local development instance

Use **Ubuntu 24.04 x86_64**, with sudo access, **4 CPUs, 16 GiB RAM, and 40 GiB
free disk**. Internet access is required. macOS, Windows, and ARM are not yet
supported by this installer; use an Ubuntu machine or VM.
Without Airbyte, use **4 CPUs, 8 GiB RAM, and 20 GiB free disk**.

```sh
git clone https://github.com/getopencrawl/opencrawl-core.git
cd opencrawl-core
./dev/up
```

For agent capture, memories, search, and board without external sources:

```sh
./dev/up --no-airbyte
```

This uses Docker Compose only: no Airbyte, Kubernetes, Helm, or connector credentials.
Repeat `--no-airbyte` on each startup; running `./dev/up` enables the full stack.
Switching modes preserves existing data. External source access and syncing are
unavailable while Airbyte is disabled.

From an existing checkout, just run your chosen command. The script installs
its tools, starts all dependencies, and creates a local account. No service credentials,
OAuth application, Node installation, or `.env` editing is required. Sudo may
ask for your system password. The first run downloads and builds images and can
take tens of minutes.

1. Open **http://localhost:8092**.
2. Sign in with the email and password printed when startup finishes. They are
   also saved in `.opencrawl-dev/login.txt`.
3. Follow onboarding to connect your coding agent, choose integrations, and
   invite teammates. Connecting an integration is optional: skip it and the
   workspace opens on agent capture alone. Each integration says what it
   needs. With Airbyte enabled, an admin can add a Composio API key in the product
   to enable Notion, Circleback, and Slack sign-in. Google Drive indexing is not yet supported.

To try sample data instead, run `./dev/up demo` (or `./dev/up demo --no-airbyte`).
This explicitly completes onboarding and imports synthetic records; search for **`lunar otter`** in
**Diagnostics → Search inspector** afterward.

Airbyte is available at **http://localhost:8000**. Ports bind to loopback; for a
remote machine, use an SSH/SSM tunnel. This setup is for development. Connecting
real sources still requires your own connector credentials or OAuth application.
See the [integration setup guide](docs/self-host.md#connect-sources).

```sh
./dev/up status       # Show service status
./dev/up stop         # Stop services and keep data
./dev/up              # Resume the same instance
```

See the [development guide](dev/README.md) for port settings, remote access,
resetting disposable data, and troubleshooting details, or the
[clean-machine verification](docs/dev-install-acceptance.md) for tested behavior.

## Major dependencies

The development installer provisions these automatically:

| Dependency | Purpose |
| --- | --- |
| Node.js and React | Application backend and web console |
| Better Auth and SQLite | Local accounts, membership, and application state |
| Airbyte (optional) | External source connectors and data synchronization |
| S3-compatible storage | Captured sessions and connector output; SeaweedFS locally |
| Temporal and PostgreSQL | Durable background jobs and workflow state |
| OpenSearch | Indexing and search |

The dev stack uses Docker Compose, plus a local kind Kubernetes cluster when
Airbyte is enabled. Airbyte's supported deployment requires Kubernetes; OpenCrawl's
own services run in Compose. Production deployments can operate the dependencies independently;
the application does not depend on the dev installer. See the
[self-hosting guide](docs/self-host.md) for operator-managed deployment.
Third-party dependencies retain their own licenses.

## More

- [CLI](cli/README.md) and [MCP](docs/mcp.md)
- [Capture privacy and controls](docs/capture-privacy.md)
- [Architecture](ARCHITECTURE.md), [contributing](CONTRIBUTING.md), and [security](SECURITY.md)

[Apache-2.0](LICENSE). Plugins are MIT; bundled fonts retain their OFL notices.
