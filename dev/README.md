# One-command development workspace

On a clean Ubuntu 24.04 x86_64 machine with sudo access, clone this repository and run:

```sh
./dev/up
```

No service account, OAuth application, Node installation, `.env` editing or manual
Airbyte setup is required. The script installs Docker/Compose from Ubuntu's signed
package repositories when absent; sudo may ask for your system password. With
Docker already installed and accessible, other Linux x86_64 distributions can run
the same command. Ubuntu 24.04 is the clean-machine verification target. macOS,
Windows and ARM are not yet verified or supported by this installer.

Provide 4 CPUs, 16 GiB RAM and at least 40 GiB free disk. The first run downloads
images and builds the shared React console and backend, so it requires internet
access and can take tens of minutes. Subsequent runs reuse tools, images and data.

After verification succeeds, the command prints the application URL, email, and
password directly in the terminal. It also saves them in a private login file.
By default the application is at `http://localhost:8092` and Airbyte is at
`http://localhost:8000`. A generated local Better Auth account is ready to use.
The installer exercises a real device grant, refresh, MCP call and synthetic
capture so the development account has completed normal onboarding.
To find the credentials later, read `.opencrawl-dev/login.txt` (use
`sudo cat .opencrawl-dev/login.txt` if sudo created the installation).

It creates two **synthetic meeting records**, explicitly labeled as development
samples. A private fixture HTTP service is read by an Airbyte declarative source.
Airbyte's real S3 destination writes gzip JSONL to SeaweedFS; the normal OpenCrawl
Temporal worker indexes it into OpenSearch. Startup succeeds only when
authenticated MCP and browser search retrieve `lunar otter`. The sample uses the
existing meeting schema and appears under Granola with a synthetic-account label;
no Granola service or personal data is accessed. A synthetic agent session is
also clearly labeled.

Real external sources still require their owner's connector credentials or OAuth
application. The zero-input preview uses only local synthetic data; it does not
connect to your Google, GitHub, Slack or other accounts automatically.

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
Node, kind, kubectl, Helm and the Airbyte chart are pinned and checksum-verified.
Third-party images and charts retain their own licenses.

The pinned Airbyte 2.4 chart has an [upstream fresh-install catalog bug](https://github.com/airbytehq/airbyte/issues/84928).
The installer adds the missing, digest-pinned CDK 7 entry only to its own new
Airbyte database. It leaves existing catalog entries intact and never applies
this compatibility step to an external Airbyte installation.

## Lifecycle

```sh
./dev/up              # Resume and verify the same installation
./dev/up status       # Show owned services and last verification time
./dev/up stop         # Stop owned services; retain accounts, grants and data
./dev/up reset --yes  # Permanently delete only this clone's development stack
```

An interrupted installation can be rerun. Previously created Airbyte resources
are reconciled; uncertain creates fail visibly instead of creating duplicates.
If you remove the sample source or change the generated account's password,
verification fails rather than reversing your change. Reset is for disposable
data only. Moving a populated state directory to another clone is rejected;
start that clone independently. Concurrent installers in one clone are rejected.

Choose ports on the **first run** when needed:

```sh
OPENCRAWL_DEV_PORT=8192 OPENCRAWL_DEV_AIRBYTE_PORT=8100 ./dev/up
```

Ports and credentials are saved for reruns. The sanitized acceptance receipt is
`.opencrawl-dev/verification.json`: Airbyte job/row count, Temporal workflow ID,
retrieval and authorization checks, and completion time, without tokens/passwords.
