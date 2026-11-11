# Continuous delivery

Merging into protected `main` is the release decision. Core CI, repository
security, plugin validation and self-host checks must all succeed on the exact
main revision before the core continuous-delivery workflow can publish it.
Failed, cancelled, untrusted and superseded revisions cannot advance the channel.

The private package uses a deterministic version such as
`0.3.4-cd.123.g0123456789ab`, derived from the source version, main history count
and source SHA. It includes that source revision in `revision.json` and registry
metadata. Rerunning delivery reuses the same immutable package and verifies its
identity. The `continuous` dist-tag advances only after rechecking current main
and its gates. Stable manual package publication remains available for explicit
self-host releases; it is not required for hosted delivery.

The hosted consumer owns its independent promotion automation. It verifies the
archive integrity and embedded revision, updates its package, lock and source pin
together, runs its own protected-branch checks and deploys its checked immutable
image with drain, rollback and public verification. Core has no dependency on
that consumer or its infrastructure.

CLI changes on main automatically allocate a stable version greater than the
published `next` channel unless the committed version is already newer. The same
version is used for the build and all Linux, macOS and Windows checks. Publication
promotes `next` only after every platform and the launcher are downloadable.
Source provenance is included in the launcher package. No manual publish dispatch
or version-reservation queue is needed after automation is enabled.

Merge changes only when they are ready for normal deployment. A one-time data
transition must be encoded in the deployment path before merging dependent
runtime changes. Failed validation leaves the current release serving; reruns
and hosted reconciliation resume incomplete delivery.
