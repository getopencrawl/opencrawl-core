# Development installer acceptance

Run `./dev/up` from a clean clone of `codex/core-shell-seam`. See
[development setup](../dev/README.md) for the supported machine, generated login,
ports and lifecycle commands. This acceptance covers the development distribution;
it does not replace the production self-host checklist.

Normal `./dev/up` preserves first-run onboarding. `./dev/up demo` explicitly
runs the synthetic ingestion and onboarding exercise. It never imports personal
agent history.

## First-run UI and integrations

Implementation `8bb0bf35db8741d9715975312b9a19f2ac627ff6` passed a clean Ubuntu
24.04 x86_64 install, without preinstalled Docker, Node or npm, in **291 seconds**.
A real Chromium browser signed in with the generated account and verified
`completed: false`, the agent onboarding screen, no page errors and no horizontal
overflow at 1280×900 and 390×844. Workspace APIs correctly remained gated until
onboarding completed.

The explicit demo then passed real Airbyte → S3 → Temporal → OpenSearch ingestion
and authenticated retrieval. A second browser check verified all six integration
cards, the Google Drive setup dialog, the Agent setup navigation, and the source
onboarding screen on desktop and mobile. These checks used only the generated
development account and synthetic fixture. Screenshots and JSON from the first
login, plus the sanitized preview API receipt, are in
[the first-run evidence directory](evidence/dev-first-run-20261110/).

The existing OSS preview runs that exact revision. Its authenticated API shows
all six providers and preserves its existing synced GitHub connection. Existing
accounts retain their completed onboarding and can reopen it through Agent setup.
The cloud preview's containers were not changed.

A second installation ran as an ordinary Docker-enabled user. Its explicit demo
completed in **345 seconds**; generated seed files belonged to that user.
Stop/resume preserved credentials, organization, workspace and source/job IDs.
Non-root reset completed in **13 seconds**, removed the installation's state,
cluster and Compose volumes, and preserved an unrelated container, network,
volume and its stored sentinel. Root-owned installation reset also passed.

[Core CI](https://github.com/getopencrawl/opencrawl-core/actions/runs/42845069020)
and [self-host CI](https://github.com/getopencrawl/opencrawl-core/actions/runs/42845068528)
passed for this implementation, including strict React checks, browser regressions,
real Temporal and storage checks, capture, restart and backup/restore.

The catalog is visible without external credentials; authorization of a real
provider still requires operator configuration. The optional Composio adapter
has contract and scope tests. This check did **not** authorize real Google Drive,
Notion, Circleback or Slack accounts through Composio.

## Earlier installer verification

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

The original installer at `fa42dd6` only composed existing production adapters;
it left the runtime and shared UI unchanged. The later `8bb0bf3` correction also
updates core's connector catalog, optional operator-owned OAuth adapter and shared
React UI. The installer and fixture remain absent from the runtime image/package.
The OSS preview uses an image built directly from that revision; the privately
published `0.3.0-seam.7` package and cloud preview remain on the earlier runtime.
A new immutable core package release is required before cloud consumes the new
runtime. Main and production data are unchanged; no migration was performed.

Airbyte 2.4's fresh catalog lacks CDK 7. The compatibility step inserts the pinned
missing entry only in the installer's own dedicated database; it leaves existing
entries intact. Search readiness observes the authenticated read path, preserving
the normal indexing/refresh policy. Both fixes stay outside product runtime code.

This is a Linux x86_64 development preview with synthetic data. macOS, Windows,
ARM, minimum-memory tuning and real provider OAuth setup are outside this check.
Connecting a real external source still requires its operator-owned credentials.
