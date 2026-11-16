# Helm 0.1.0 release acceptance

This is a second, independent EKS run after the final PostgreSQL app-state merge.
It used the extracted installer kit and anonymous public images. Installation
required Node, Helm and kubectl; it used no application build or npm install.
All data was synthetic. No hosted deployment changed.

The tested runtime/connector source is `b9e4ccea6985643fde94b71955dcb50f47b93236`.
The runtime index digest is
`sha256:9d915042997692d7f534986f4b6cebcd2e4b5b9e00d40f72d6c9c55cb3e5cd00`;
the GitHub connector index digest is
`sha256:3dea55464e16fec0b6cf949c48ad2757310c14d6816c8cdbdd7b4bd7623397d5`.
This includes the final PostgreSQL contract from merged PR312, the connector
activation hook and custom application-name support. Later documentation links
and unrelated mainline changes do not extend this runtime's acceptance claim.

The cluster was `opencrawl-helm-release-1115`, AWS staging account `017535066453`,
region `us-east-1`, EKS 1.34 with two amd64 workers. The existing staging VPC,
subnets and NAT were reused.

| Receipt | Evidence |
| --- | --- |
| `configurations.json` | The exact bundled, mixed external PostgreSQL/OpenSearch/S3, and entirely external configurations. Secret names are references; credentials are excluded. |
| `kubernetes-schema.json` | Kubernetes API admission for all 16 backend combinations and the application with activation hook. A temporary test ServiceAccount satisfied Pod admission. |
| `fresh.json` | All three installations passed 15 application checks and native Helm tests. |
| `external-database-connections.json` | Observed connections for the mixed app, Temporal and Airbyte consumers through their independent external database owners. |
| `external-fixtures.json` | Separately provisioned databases/roles, Temporal namespace and Airbyte workspace used by the external configurations. |
| `helm-upgrades.json` | All three installers reran as Helm upgrades against the same pinned image; organization/workspace identities remained stable. Each activation hook completed. |
| `after-upgrade.json` | Existing accounts and captured/searchable fixtures passed 13 checks per installation without reseeding. First three directed cross-installation marker-denial checks. |
| `pod-replacement.json`, `after-restart.json` | All six app/worker Pod UIDs changed and became ready; retained probes and the reverse three marker-denial checks passed. |
| `runtime-fresh.json`, `runtime-final.json`, `runtime-image-binding.json` | Actual app/worker image IDs, readiness, absence of image-pull Secrets and activation receipts. All twelve fresh/final observations match the public runtime index and amd64 config digest. |
| `public-images.json` | Anonymous access to both architectures of both exact images, including manifest/config hashes, matching source labels and every layer endpoint. |
| `ci.json` | Successful exact-source core, full upgrade, image, chart and security workflows. Full upgrade CI includes the retained Airbyte connector path. |
| `aws-inventory.json`, `fixture-cleanup.json` | Owned resource inventory and verified deletion of all disposable namespaces and six test-data volumes before stopping the storage driver. |

This EKS run proves fresh PostgreSQL installations, Helm reruns and pod replacement.
The hook's fresh-install result is `required: false, completed: true`; it does not
claim a migrated connector catch-up occurred in these EKS fixtures. The exact-source
CI receipt covers legacy/full application upgrades and retained connector activation.
The earlier EKS connector-container pipeline is recorded separately under
`../helm-v1-20261115/`; it tested an earlier persistence candidate.

Retained-state probes obtain new OAuth grants; they do not prove that an old grant
survived. External TLS endpoints and a complete bundled ARM64 stack were not run on
this cluster. Namespace/index checks establish logical data separation on shared
services, not independent capacity or availability. This v1 provides no HA or
automatic backups. Application database rollback follows the runtime's verified
migration/backup procedure, not Helm rollback alone.

The final cluster/stack/instance/volume/IAM teardown audit is published with Helm
0.1.0 as [helm-v0.1.0-cleanup.json](https://github.com/getopencrawl/opencrawl-core/releases/download/helm-v0.1.0/helm-v0.1.0-cleanup.json).
`termination-hooks.json` records completion of only the task nodes’ termination
waits after the node group was deleting, desired capacity was zero, and all test
namespaces and persistent volumes were gone. Shared staging resources are retained.
