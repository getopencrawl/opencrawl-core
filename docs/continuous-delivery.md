# Continuous delivery

Merging into protected `main` is the release decision. Core CI, repository
security and plugin validation must all succeed on the exact
main revision before the core continuous-delivery workflow can publish it.
Failed, cancelled, untrusted and superseded revisions cannot advance the channel.
Callbacks evaluate the current default-branch revision; the triggering job's
older revision is never substituted for it. Core CI runs unit, browser, real
storage/workflow integrations and sharded CLI consumer tests in parallel.
Every shard is required on PRs; distribution publication is a separate gate.
Main may reuse a successful PR runtime check only when a run-bound receipt and
GitHub's commit tree prove that the merged source is identical. The receipt must
come from the latest successful Core CI run for the merged same-repository PR;
its repository, source tree, head, run and attempt must match. Missing, expired,
changed or inaccessible evidence runs the complete suite again. Security and
plugin checks still run on main, and stable distribution gates are independent.
Protected PRs require `test`, `validate` and `Secret scan`. The full self-host
installation suite runs on main as stable-release candidate validation;
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
distribution gate, even when newer main commits are still being checked. That
source stays fixed during packaging and its gates are rechecked before publish. Full
installation, backup/restore, architecture and image checks remain
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

After successful publication, the upstream repository dispatches the hosted
consumer workflow with the exact package version and full source revision.
A dedicated GitHub App, installed only on the hosted repository with Actions
write permission, supplies a short-lived notification token. Its client ID is
`CLOUD_DISPATCH_APP_CLIENT_ID` and its key is the repository secret
`CLOUD_DISPATCH_APP_PRIVATE_KEY`. The existing hosted PR app is separate.
Only the trusted upstream main publication path can use this identity; forks
and self-host builds do not require it. A notification failure fails the workflow
visibly; rerunning delivery reuses the immutable publication and retries the
notification. The consumer rejects mismatched identities, duplicate deployments
and downgrades. Core check-completion events drive publication, and publication
drives consumption; neither repository needs a scheduled polling job or an idle
watcher for this handoff. Stable tagged distribution is unchanged.

For a core-to-hosted latency measurement, start at the core PR's `mergedAt`
timestamp and stop only when the consumer's full production verification has
completed, including its API and background workers. Include publication,
dispatch, queueing, consumer validation and rollout time. Record the immutable
core revision, package version, consumer revision and workflow receipts together.
An idle-start measurement first confirms that no consumer controller or prior
production rollout is active; it must use the automatic publication notification.
Early API health or controller success alone does not establish completion.
A single successful sample establishes that run's latency, not a percentile or SLA.

## CLI delivery

Native installers and managed native updates follow `release.json` on the
`cli-stable` branch. The release job advances the pointer atomically after
verifying anonymous downloads of the versioned GitHub assets. npm installations
follow npm's `latest` tag. All six packages upload under a staging tag. Promotion
waits until every tarball is downloadable with the expected source and integrity.
The `next` alias follows `latest` for existing clients.
The native release queue ends when the native pointer advances. npm publishing
has its own ordered queue, allowing the next native release to ship during a scan.

PRs build a candidate version above the occupied native tags and npm versions.
Main rechecks the version, builds from its own checkout and compares the Git tree
and distributed contents with the successful PR receipt. A changed version,
payload or tree, or a missing receipt, runs all platform checks on main.
Core CI owns the full core suite.

Core declares its compatible released CLI in `package.json`
(`opencrawlCliVersion`). Delivery verifies that exact version and its mainline
source provenance, then stamps it into cloud setup and release metadata.
A server change requiring a newer client must explicitly advance this dependency
after the client is released. Cloud installations keep an exact version pin.

Merge changes only when they are ready for normal deployment. A one-time data
transition must be encoded in the deployment path before merging dependent
runtime changes. Failed validation leaves the current release serving; reruns
and hosted reconciliation resume incomplete delivery.

