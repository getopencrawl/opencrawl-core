# Development installer acceptance

Run `./dev/up` from a clean clone of `codex/core-shell-seam`. See
[development setup](../dev/README.md) for the supported machine, generated login,
ports and lifecycle commands. This acceptance covers the development distribution;
it does not replace the production self-host checklist.

Normal `./dev/up` now preserves first-run onboarding. `./dev/up demo` explicitly
runs the synthetic ingestion and onboarding exercise described below. Historical
receipts below were collected when that demo ran automatically at startup.

## Verified behavior

- A clean Ubuntu 24.04 x86_64 EC2 machine, 4 CPUs and 16 GiB RAM, starts without
  Docker, Node or npm. An ordinary sudo-capable user runs one command, with no
  provider account, connector secret, environment editing or manual Airbyte setup.
- The installer starts the shared React/backend image, local Better Auth,
  OpenSearch, S3-compatible storage, OpenCrawl Temporal and a separate full
  Airbyte platform. It generates local secrets and owns its cluster/volumes.
- Two explicitly synthetic meeting records travel through a real Airbyte source
  and S3 destination, then the normal Temporal worker and OpenSearch. Authenticated
  MCP and browser search retrieve the imported text. Device grant, refresh,
  onboarding completion and negative scope/origin checks pass.
- A real Chromium browser signs in and renders the sample search results without
  page errors. Stop/resume and repeated startup preserve credentials, workspace,
  connector definition, connection and Airbyte job IDs.
- Published ports bind to loopback. Normal app/worker containers have no Docker
  socket, Kubernetes credentials or dev-script mount. Reset requires `--yes`.
  Confirmed reset deletes owned state, cluster, containers and volumes while
  preserving an unrelated test container, volume, network and stored sentinel.

The initial clean one-shot run at `408ff8a` completed in 449 seconds. The final
implementation `fa42dd61603749090f594c96b91d4eb8908c27b5` passed a second empty-machine,
clean-clone one-shot run in **641 seconds**, including the Kubernetes authorization
and database recovery checks added for restart. That revision passed `npm test` (321 passed, 24 optional skips), strict
tooling checks, the browser check and lifecycle checks. Sanitized machine,
ingestion and browser receipts are in [the evidence directory](evidence/dev-installer-20261110/).
The implementation's [Core CI](https://github.com/getopencrawl/opencrawl-core/actions/runs/42763410487)
and [self-host CI](https://github.com/getopencrawl/opencrawl-core/actions/runs/42763410467)
passed, including React/browser regression checks, real Temporal tests, capture,
restart and backup/restore.

## Scope and reproducibility

`dev/` only composes existing production adapters and bootstraps local demo data.
Compared with pre-installer `6dba6df`, `src/`, `web/`, `web-v2/`, `deploy/`, package
metadata and runtime lockfiles are unchanged. The installer and fixture are absent
from the runtime image/package. No core package release or hosted shell pin change
is needed. Main, production data and the established OSS/cloud previews are unchanged.

Airbyte 2.4's fresh catalog lacks CDK 7. The compatibility step inserts the pinned
missing entry only in the installer's own dedicated database; it leaves existing
entries intact. Search readiness observes the authenticated read path, preserving
the normal indexing/refresh policy. Both fixes stay outside product runtime code.

This is a Linux x86_64 development preview with synthetic data. macOS, Windows,
ARM, minimum-memory tuning and real provider OAuth setup are outside this check.
Connecting a real external source still requires its operator-owned credentials.
