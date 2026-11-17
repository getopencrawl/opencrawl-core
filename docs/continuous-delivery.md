# Continuous delivery

Merging into protected `main` is the release decision. Core CI, repository
security and plugin validation must all succeed on the exact
main revision before the core continuous-delivery workflow can publish it.
Failed, cancelled, untrusted and superseded revisions cannot advance the channel.
Callbacks evaluate the current default-branch revision; the triggering job's
older revision is never substituted for it. Core CI runs unit, browser, real
storage/workflow integrations and sharded CLI consumer tests in parallel.
Every shard is required; distribution publication is a separate gate.
Protected PRs require `test`, `validate` and `Secret scan`. The full self-host
installation/upgrade suite runs on main as stable-release candidate validation;
it no longer runs twice on each feature branch or gates ordinary PR merges.

The private package uses a deterministic version such as
`0.3.4-cd.123.g0123456789ab`, derived from the source version, main history count
and source SHA. It includes that source revision in `revision.json` and registry
metadata. Rerunning delivery reuses the same immutable package and verifies its
identity. The `continuous` dist-tag advances only after rechecking current main
and its gates. This is the unstable development channel. Consumers keep immutable versions,
never a floating source checkout. Stable self-host kits are tagged `helm-v*`
from tested commits on main every Monday, or earlier by explicit release dispatch.
The weekly cut selects the newest mainline candidate that has passed every
distribution gate, even when newer main commits are still being checked. Full
installation, historical upgrade/restore, architecture and image checks remain
mandatory. A failed stable gate fails the release rather than
labeling the development build stable; it does not pause cloud delivery.
Manual stable private-package publication also requires a matching `v<version>`
tag on that mainline commit and the full distribution gates. An untagged main
revision can only be published as an immutable development/revision package.

The hosted consumer owns its independent promotion automation. It verifies the
archive integrity and embedded revision, updates its package, lock and source pin
together, runs its own protected-branch checks and deploys its checked immutable
image with drain, rollback and public verification. Core has no dependency on
that consumer or its infrastructure.

CLI changes on main allocate a version above all published CLI artifacts unless
the committed version is already newer. The same version is used for the build
and all Linux, macOS and Windows checks. All six packages advance `latest` only
after their archives are downloadable. The `next` alias stays synchronized for
installed clients, and staging tags are removed after promotion.
Source provenance is included in the launcher package. No manual publish dispatch
or version-reservation queue is needed after automation is enabled.
Core declares its compatible released CLI in `package.json`
(`opencrawlCliVersion`). Delivery verifies that exact version and its mainline
source provenance, then stamps it into cloud setup and release metadata.
Independent client builds and npm uploads do not block core. A server change
requiring a newer client must explicitly advance this dependency after that
client is released. Cloud installations keep an exact version pin.

Merge changes only when they are ready for normal deployment. A one-time data
transition must be encoded in the deployment path before merging dependent
runtime changes. Failed validation leaves the current release serving; reruns
and hosted reconciliation resume incomplete delivery.
