# One-command development workspace

On a clean Ubuntu 24.04 x86_64 machine with sudo access, clone this repository and run:

```sh
./dev/up
```

Use `./dev/up --no-airbyte` for agent capture, memories, search, local accounts and
board without external sources. This starts only Docker Compose services and
does not download kind, kubectl, Helm, or Airbyte. Use 4 CPUs, 8 GiB RAM and 20 GiB
free disk in this mode. Source cards explain that Airbyte is disabled.
Repeat the flag for every startup or demo; `./dev/up` without it enables Airbyte.
Switching to this mode stops this clone's Airbyte cluster and connector workers
without deleting connections, grants or data. External source reads and changes
remain unavailable until Airbyte is enabled again. `stop`, `status`, and `reset --yes`
operate on the whole installation without a mode flag.

No service account, OAuth application, Node installation, `.env` editing or manual
Airbyte setup is required. The script installs Docker/Compose from Ubuntu's signed
package repositories when absent; sudo may ask for your system password. With
Docker already installed and accessible, other Linux x86_64 distributions can run
the same command. Ubuntu 24.04 is the clean-machine verification target. macOS,
Windows and ARM are not yet verified or supported by this installer.

Provide 4 CPUs, 16 GiB RAM and at least 40 GiB free disk. The first run downloads
images and builds the shared React console and backend, so it requires internet
access and can take tens of minutes. Subsequent runs reuse tools, images and data.

After startup succeeds, the command prints the application URL, email, and
password directly in the terminal. It also saves them in a private login file.
By default the application is at `http://localhost:8092` and Airbyte is at
`http://localhost:8000`. A generated local Better Auth account is ready to use.
Your first sign-in opens the normal onboarding flow. Startup does not connect an
agent, invent capture receipts, complete onboarding, or import demo records.
To find the credentials later, read `.opencrawl-dev/login.txt` (use
`sudo cat .opencrawl-dev/login.txt` if sudo created the installation).

## Optional demo data

Run `./dev/up demo` to complete onboarding automatically and load sample data.
With `./dev/up demo --no-airbyte`, the sample is an agent session instead of a
meeting import. It verifies the real session indexing workflow, MCP and product
search, board read/write, local login, device/refresh grants and scope checks.
This optional command exercises a real device grant, refresh, MCP call and
synthetic capture, then creates two **synthetic meeting records**, explicitly labeled as development
samples. A private fixture HTTP service is read by an Airbyte declarative source.
Airbyte's real S3 destination writes gzip JSONL to SeaweedFS; the normal OpenCrawl
Temporal worker indexes it into OpenSearch. The demo succeeds only when
authenticated MCP and the product search API retrieve `lunar otter`. The sample uses the
existing meeting schema and appears under Granola with a synthetic-account label;
no Granola service or personal data is accessed. A synthetic agent session is
also clearly labeled.

Real external sources still require their owner's connector credentials or OAuth
application. The demo uses only local synthetic data; it does not
connect to your Google, GitHub, Slack or other accounts automatically.

All six integration cards remain visible. Connections that need operator setup
say what they are waiting for, and onboarding can finish without any of them.
An admin can add the Composio API key in the product, on the Sources step or the
Integrations page: it is checked, stored encrypted, and used without a restart.
Other connector settings go in the private `.opencrawl-dev/connectors.env` file;
rerun `./dev/up` after editing it. A key set there cannot be replaced in the
product. The accepted settings
are `COMPOSIO_API_KEY`, `COMPOSIO_BASE_URL`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `GITHUB_APP`,
`AIRBYTE_GITHUB_REPOSITORY`, `AIRBYTE_GITHUB_TAG`, and `OPENCRAWL_AIRBYTE_APP_URL`.
See [source setup](../docs/self-host.md#connect-sources) for credential ownership
and callback requirements. No provider credential is required to start the app.

An existing installation keeps its accounts, data, and onboarding state. The
installer never resets a completed user's setup. Use **Agent setup** in the
sidebar to revisit onboarding.

## Development boundaries

This is not a production deployment recipe. Published ports bind to loopback. On
a remote VM, use an SSH/SSM tunnel, or set `OPENCRAWL_DEV_ORIGIN` to your own HTTPS
reverse proxy URL on the first run. The installer does not create public ingress,
a domain, TLS certificates or a tailnet account. Random credentials are retained
in `.opencrawl-dev/` with private file permissions. Do not commit/share that folder.

`dev/` composes and initializes existing adapters. Production still uses
[`deploy/compose.yaml`](../deploy/compose.yaml) or independently operated services
through the interfaces in [self-host.md](../docs/self-host.md). Application and
worker containers receive no Docker socket, Kubernetes credentials, development
auth bypass or dependency on this installer. Fixture code is mounted only into a
separate source service and the one-shot seed container, and is absent from the
product image and published runtime package.

Airbyte uses its official Helm chart in a uniquely named kind cluster. Its
internal workflow engine/database remain separate from OpenCrawl's. A dedicated
kubeconfig leaves the user's default context and pre-existing Airbyte alone.
Source jobs reach the app's credential proxy at a stable in-cluster name,
`opencrawl-app.airbyte.svc.cluster.local:8092`, which each run points at the
current app container and verifies from inside the cluster. The browser origin
is this machine's loopback, which a job cannot reach. `OPENCRAWL_AIRBYTE_APP_URL`
in `.opencrawl-dev/connectors.env` overrides the address.
Node, kind, kubectl, Helm and the Airbyte chart are pinned and checksum-verified.
Third-party images and charts retain their own licenses.

The pinned Airbyte 2.4 chart has an [upstream fresh-install catalog bug](https://github.com/airbytehq/airbyte/issues/84928).
The installer adds the missing, digest-pinned CDK 7 entry only to its own
Airbyte database, and keeps that entry and the declarative connectors already
registered there on the pinned runtime when the pin changes. Other catalog
entries stay intact, and this step is never applied to an external Airbyte
installation. The pin must be recent enough for every connector manifest:
Notion and Google Drive use `WaitTimeFromResponse`, which runtime 7.28.2
rejects. `OPENCRAWL_TEST_CONNECTOR_RUNTIME=1 node --test test/connector-runtime.test.mjs`
runs every manifest's discovery in the pinned runtime image (needs Docker).

## Lifecycle

```sh
./dev/up              # Resume and verify the same installation
./dev/up demo         # Explicitly finish onboarding and import synthetic data
./dev/up status       # Show owned services and last verification time
./dev/up stop         # Stop owned services; retain accounts, grants and data
./dev/up reset --yes  # Permanently delete only this clone's development stack
```

An interrupted installation can be rerun. Previously created Airbyte resources
are reconciled; uncertain creates fail visibly instead of creating duplicates.
If you remove the sample source, the demo check fails rather than restoring it.
If you change the generated account's password, startup fails rather than
resetting it. Reset is for disposable
data only. Moving a populated state directory to another clone is rejected;
start that clone independently. Concurrent installers in one clone are rejected.

Choose ports on the **first run** when needed:

```sh
OPENCRAWL_DEV_PORT=8192 OPENCRAWL_DEV_AIRBYTE_PORT=8100 ./dev/up
```

Ports and credentials are saved for reruns. After `./dev/up demo`, its sanitized
receipt is `.opencrawl-dev/verification.json`: Airbyte job/row count, Temporal
workflow ID, retrieval and authorization checks, and completion time, without
tokens/passwords. Normal startup does not create a demo receipt.
