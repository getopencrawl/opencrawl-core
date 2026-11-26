# Install OpenCrawl on Kubernetes

One application replica and one worker. PostgreSQL, OpenSearch, Temporal,
S3-compatible storage and Airbyte are included by default. This is a durable
single-instance installation; it does not provide HA.
It operates independently of OpenCrawl Cloud.

**No upgrade path during alpha:** there is no upgrade or import from an older
self-host version. To move to a newer release, install it fresh into empty
databases and storage; an installation on an older release keeps that release.

## Breaking change in OpenCrawl Core 0.5.0 (Helm chart 0.2.0)

Core 0.5.0 stores self-hosted Better Auth accounts, sessions and OAuth grants in
the application PostgreSQL database configured by `OPENCRAWL_DATABASE_URL`.
There is no SQLite authentication backend or fallback. `databases.app` serves
both authentication and application state; no separate auth database is needed.

There is no import from earlier SQLite installations: install into an empty
PostgreSQL database. Do not point old binaries at the new database.

## Agent installation

Each self-host release names the application first and the chart to pin second.
For example, **OpenCrawl Core 0.6.0 (Helm chart 0.3.0)** uses tag `helm-v0.3.0`.
Use the latest stable `helm-v*` [release](https://github.com/getopencrawl/opencrawl-core/releases)
and its self-host kit with Node 24+, Helm 3 and kubectl. No image build,
application checkout or npm install is needed. A Kubernetes cluster, a default
dynamic StorageClass, DNS and (for remote use) an HTTPS ingress are operator inputs.
Use a network-policy-capable CNI. Start with `examples/bundled.json`, choose the
explicit kubectl context, namespace and HTTPS URL. The published kit's `release.json`
supplies a tested runtime digest and matching connector revision tag. Source-checkout
users must choose a published image explicitly.

```sh
node install.mts --config instance.json
node install.mts --config instance.json --apply
node verify.mts --config instance.json
```

The first command prints a JSON plan without contacting Kubernetes. The installer
prints JSON progress and an installation receipt. A failed command exits nonzero.
The final receipt means Helm reports ready; run verification for application proof.

The installer applies three ordinary Helm releases, in order:

1. `<release>-infra`: selected bundled databases and backends.
2. `<release>-airbyte`: pinned upstream Airbyte 2.4.0, if selected.
3. `<release>`: scoped initialization Job, application and worker.

The scoped initialization Job admits auth, registry and board before runtime startup.
The application and worker use the established indexing workflow contracts.
Use `--wait` and an adequate `--timeout` with direct Helm installations.

Airbyte's pre-install bootloader needs its database to exist already. Separate
releases preserve the upstream chart's lifecycle. The installer validates the
downloaded Airbyte chart checksum and uses a separate Temporal server for Airbyte.
It never deploys application workloads into Airbyte's Temporal namespace.
An enclosing chart overrides the upstream JDBC URL and Temporal hostname-verification
templates to enforce PostgreSQL TLS settings without duplicate environment variables. Upstream
bootstrap hooks and resource templates remain intact.

Generated Kubernetes Secrets persist across reruns. Local `.opencrawl-helm/`
contains private installation values and a binding journal; keep it private and
exclude it from source control. Temporary Airbyte values containing its generated
MinIO password are removed after Helm runs. Helm release Secrets still contain
those values: restrict access to Secrets and enable cluster encryption at rest.

Retrieve the initial setup token from `<release>-runtime-credentials`, key
`OPENCRAWL_SETUP_TOKEN`, through your secret-management process and open the configured
URL at `/auth/signup?setup=<token>` to create the first administrator. Credentials are never printed by these tools.
For localhost trials, use `http://localhost:8092` and a scoped `kubectl port-forward`
to the application Service. A remote installation needs your HTTPS ingress.

## Replace one component at a time

Each of `temporal`, `opensearch`, `objectStorage` and `airbyte` selects
`mode: bundled` or `mode: external`. Airbyte also supports `disabled` for capture-only
installations. An external component is not created or administrated by the chart.
Examples demonstrate bundled, mixed and entirely external arrangements.

`databases.app`, `databases.temporal` and `databases.airbyte` independently select
bundled or external PostgreSQL. Bundled mode uses one server with distinct database
owners. Temporal owns two databases; Airbyte owns its application database and its
own Temporal databases. App credentials never grant PostgreSQL superuser access.
Turn off `postgresql.enabled` when no bundled database is needed.

Create referenced Secrets in the installation namespace before applying:

| Consumer | External connection | Secret keys |
| --- | --- | --- |
| App PostgreSQL | `databases.app.existingSecret` | `OPENCRAWL_DATABASE_URL` (complete URL, including TLS options) |
| Bundled Temporal using external PostgreSQL | `databases.temporal.host`, `port`, `user`, `name`, `visibilityName`, `existingSecret` | `TEMPORAL_DATABASE_PASSWORD` |
| Bundled Airbyte using external PostgreSQL | `databases.airbyte.host`, `port`, `user`, `name`, `temporalName`, `visibilityName`, `existingSecret` | `DATABASE_USER` (same as `user`), `DATABASE_PASSWORD` |
| External Temporal | `temporal.address`, `namespace`, optional `existingSecret` | `TEMPORAL_API_KEY` when using API-key authentication |
| External OpenSearch | `opensearch.url`, optional `index`, `existingSecret` | `OPENCRAWL_OPENSEARCH_USERNAME`, `OPENCRAWL_OPENSEARCH_PASSWORD` |
| External S3 | `objectStorage.endpoint`, `bucket`, `region`, `prefix`, `existingSecret` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| External Airbyte | `airbyte.url`, `workspaceId`, `existingSecret` | `AIRBYTE_CLIENT_ID`, `AIRBYTE_CLIENT_SECRET` |

External databases and roles must already exist and be owned by the supplied role.
External Temporal namespaces must already exist. Restrict external OpenSearch
credentials to `opensearch.index`; without an override the runtime derives a stable
index from the installation's organization ID. The index's mapping is bound to that
organization and rejects a conflicting owner. An index or Temporal namespace gives
logical separation, not separate compute capacity or availability.

For Temporal TLS use `temporal.tls.enabled: true`. For custom trust or mTLS set
`temporal.tls.existingSecret` plus `caKey`, `certKey` and `keyKey`, as applicable;
`serverName` optionally specifies the expected server name. API keys require TLS.
For an external PostgreSQL TLS connection used by bundled Temporal, set
`databases.temporal.tls: true`; mount a private CA using the infrastructure overrides.
For Airbyte's external PostgreSQL use `databases.airbyte.tls: true`; Java clients
and its Temporal server verify certificates and hostnames. `databases.airbyte.caPath`
optionally points to a private CA mounted into the Airbyte components using upstream
`airbyte.values` volume hooks. Without a custom CA, Java uses its default trust store.

External Airbyte must have network access to both `objectStorage.airbyteEndpoint`
(defaults to the S3 endpoint) and `airbyte.appUrl` for connector credential proxying.
The default app URL is namespace-qualified for an in-cluster Airbyte service.
Set these explicitly when Airbyte runs outside the cluster. Provision its own
dedicated workspace and credentials. The installer never patches an external
Airbyte catalog or changes its database.

## Customization points

Keep routine choices in `instance.json`. For precise Kubernetes configuration:

- `application`: overrides to app Helm values, including ingress, resources,
  service account annotations, scheduling, extra environment, volumes and mounts.
- `infrastructure`: overrides to bundled Helm values, including resource requests,
  storage sizes and pinned backend images.
- `airbyte.values`: upstream Airbyte Helm values.

Objects merge recursively; arrays replace the defaults. Inspect generated values
before replacing `runtime.extraEnv` or volumes, which include required Secret refs.
Do not place passwords in ordinary values or `runtime.env`. Use `valueFrom` Secret
references. `nodeSelector`, `tolerations`, `imagePullSecrets`, `storageClass`,
`runtime.appResources` and `runtime.workerResources` are supported chart values.
Use your normal ingress controller and certificate manager through `application.ingress`.

Bundled services expose ClusterIP only. Their NetworkPolicy accepts traffic only
from the same Kubernetes namespace. Use one namespace per installation; do not share
it with untrusted workloads. OpenSearch's bundled single-node service uses this
network boundary and does not enable its security plugin. External services need
their own authentication, authorization and network boundaries.

## Conformance and diagnosis

`helm test RELEASE --namespace NAMESPACE --kube-context CONTEXT --logs` verifies
app-state readiness, the application health endpoint and anonymous access denial.

`verify.mts` runs a Job using the deployed image, identity, mounted trust and network
configuration. Default probes check restricted PostgreSQL credentials, S3 access,
Temporal namespace, OpenSearch access and existing index ownership, app health,
anonymous denial and the Airbyte workspace. A fresh lazy-created index is explicitly
reported as not initialized; exercise mode must create it and verify its tenant binding. Each check emits JSON with pass/fail and a remediation hint.

On a **disposable fresh installation**, add `--exercise` to create a synthetic first
administrator and run device OAuth, duplicate capture, conflicting-event rejection,
Temporal indexing, authenticated MCP retrieval, scope/origin denial and token refresh.
It retains a synthetic account and capture fixture in the instance. Its generated
account Secret permits repeat runs after pod replacement. `--existing`
refuses to recreate the account, capture or index fixture, so a data loss cannot be
hidden by reseeding. `--deny-marker` additionally checks that a synthetic marker
from another installation is absent from authenticated search. Do not use
exercise mode as an unannounced production smoke test.

```sh
node verify.mts --config disposable.json --exercise
kubectl --context CONTEXT -n NAMESPACE rollout restart deployment/RELEASE-app deployment/RELEASE-worker
kubectl --context CONTEXT -n NAMESPACE rollout status deployment/RELEASE-app
kubectl --context CONTEXT -n NAMESPACE rollout status deployment/RELEASE-worker
node verify.mts --config disposable.json --exercise --existing
```

For infrastructure failures inspect Pods, Events, PVCs and the named release.
For app-state failures inspect `<release>-migrate-<revision>` and `app-state-ready`.
The installer supports `--through infrastructure` or `--through airbyte` to stop at
an intermediate stage. Rerun the same command/configuration to resume.

## Machine authentication

Administrators create, copy and revoke keys in **Settings → Machine keys** in the web app. Use the [agent setup instructions](../../docs/self-host.md#unattended-claude-code-agents) to connect a service.

## Versions, backup and removal

Pin a released runtime digest and chart version. When selecting the runtime by
digest only, set `githubConnector.tag` to the matching published connector tag.
There is no upgrade path from older versions during alpha: do not move an
existing installation to a newer chart or runtime in place. Install the newer
release fresh instead. Helm rollback cannot undo a database change. Back up
PostgreSQL, raw objects, credentials, and the installation journal together.
Keep the organization, storage prefix, index and Temporal binding stable. Moving
data between backends is a separate migration, not an endpoint edit.

The app provisions writable shared Git repositories on a retained PVC. Set `runtime.env.OPENCRAWL_FILES_ACCESS` to `read-only` or `off` to restrict member access. Configure its capacity with
`sharedFiles.size` or supply `sharedFiles.existingClaim`. Stop writers and back up
this claim together with PostgreSQL. In the installer config, nest these chart
values under `application.sharedFiles`. The chart also retains StatefulSet PVCs on uninstall. Removing a Helm release is not a
data wipe. Deleting the namespace can delete its claims and underlying volumes:
never use namespace deletion as an ordinary uninstall or backup strategy. Restore
and verify backups before retiring external databases or buckets. The default
single-node PostgreSQL, OpenSearch and S3 services have no automatic backup policy;
use your existing managed services when their durability/operations fit better.

No HA, autoscaling, cluster creation, DNS ownership, certificate issuance, external
database provisioning or automatic destructive cleanup is included in this v1.

## Maintainer releases

Lead self-host release notes, announcements and version-specific install instructions
with `OpenCrawl Core <appVersion> (Helm chart <version>)`. Use the chart’s
`appVersion` for Core and its `version` for the chart pin. The generated kit
README and GitHub release take both numbers from the packaged release.

Every Monday at 10:00 UTC, the release workflow selects the newest eligible
commit on `main` and cuts the next chart patch if that source is newer than the
last release. Each candidate must pass core CI, self-host installation checks,
security, plugin checks and both image builds, plus CLI and chart checks when
they run. The image workflow supplies amd64/arm64 images with SBOM and provenance.

For an urgent fix, run **Release self-host kit** on `main` as soon as the same
checks pass. Review the changes since the last kit, enter the full tested commit
SHA in `revision`, and set `version` to the next chart patch. For example, after
chart `0.3.0`, an urgent patch is `0.3.1`. Planned manual releases can also
select the next minor or major. Packaging writes the chosen chart version into
the staged chart and records it with the Core version in `release.json`.

Release runs serialize version allocation. Duplicate completion events verify the
existing release; late events cannot publish an older source over a newer release.
Uploads remain drafts until every artifact hash matches. Rerun an interrupted release
workflow to resume its reserved draft; a draft for another source blocks publication
rather than being overwritten. Existing published versions are never replaced.

Every new release reruns chart conformance and pulls both architectures with an empty
Docker credential configuration. It verifies anonymous downloads after publishing the
chart, complete installer kit, image digest receipt and SHA256SUMS. A release never
changes an operator's pinned installation. Releases do not deploy or update OpenCrawl
Cloud, and Helm releases do not replace the repository's CLI latest-release marker.
