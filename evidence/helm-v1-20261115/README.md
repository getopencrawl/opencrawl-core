# Helm v1 staging acceptance

All application data in these tests was synthetic. Validation ran in AWS staging
account `017535066453`, on disposable EKS cluster
`opencrawl-helm-v1-20261115` (Kubernetes 1.34). No hosted deployment changed.

The final application image was integration revision
`f5179347a18e10af89658bf616c879dd56114cd5`, digest
`sha256:51a00ddb1b209e4d672b6028b9038731a31dc093d4f63cb3db435de24c5409c6`.
It combined the Helm implementation with persistence-owner revision `55ae728`.
These results do not establish acceptance of later persistence revisions.

| Receipt | What was verified |
| --- | --- |
| `kubernetes-schema.json` | Kubernetes API admission of all 16 backend combinations and the application release, including its native Helm test Pod. |
| `application-fresh.json` | Three real installs, each passing 15 application checks: bundled, external PostgreSQL per consumer with external OpenSearch/S3, and entirely external services. |
| `application-upgrade-restart.json` | Existing accounts and capture/search fixtures survived candidate upgrade and app/worker replacement without reseeding. First cycle of cross-installation search denial. |
| `final-candidate.json` | All three native Helm tests and retained application probes passed on the final image. Reverse cycle of cross-installation denial. A second real Airbyte sync through the retained integration passed. |
| `airbyte-pipeline.json` | Connector containers read two synthetic records, wrote S3 objects, and triggered Temporal indexing; authenticated MCP search retrieved the result. |
| `infrastructure.json` | Bundled service readiness, unsigned S3 denial and cross-namespace network denial. |
| `external-postgres.json` | Each PostgreSQL consumer connected through its separate external database and restricted owner role. |
| `backend-retention.json` | OpenSearch, S3 and Temporal data survived backend pod replacement. |
| `publication-gate.json` | Public GHCR access was blocked; both image repositories rejected anonymous token requests. |
| `public-image-access.json` | After the approved visibility change, anonymous access succeeded for both images, both architectures, configuration blobs and every layer endpoint. This checks earlier image tags; the final PostgreSQL images are built separately. |
| `cleanup.json` | The task cluster, nodes, volumes, temporary image repositories and IAM resources were removed; shared staging networking and GitHub OIDC remained available. |

The agent-facing conformance runner is `deploy/helm/verify.mts`; the real Airbyte
pipeline additionally used the repository's `dev/seed.mts` and `dev/fixture.mts` in
disposable Kubernetes Jobs. `--existing` forbids recreating its retained account,
capture and index fixtures. The retained-state probes obtain new OAuth grants;
they do not prove that a grant issued before upgrade survived.

External-service TLS is covered by configuration tests, not a live TLS endpoint
in this EKS run. Namespace/index isolation is logical separation on shared backend
capacity, not independent availability. This v1 has one app and one worker and
does not claim HA. These original EKS receipts predate the final persistence merge
and public kit publication. Later release evidence must identify its own immutable
runtime revision; public access does not by itself establish application acceptance.
