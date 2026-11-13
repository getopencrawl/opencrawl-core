# Core and hosted shell acceptance

These are release predicates, not a claim that an arbitrary checkout has passed.
Record the exact source revision, dependency versions, commands and results for
each candidate. Tests using provider fixtures do not establish live provider access.

1. A clean machine builds and starts the complete OSS application using this
   repository and operator-owned dependencies. It still functions with
   OpenCrawl-operated services blocked. `./dev/up` supplies disposable development
   dependencies; production operators can configure each dependency separately.
2. Multiple local Better Auth users share one organization. Current membership,
   admin roles, account recovery and private-resource access are enforced by the
   server. Missing or foreign scope fails closed.
3. The OSS application imports a real supported connector through operator-owned
   Airbyte, indexes it in OpenSearch, and retrieves it through both the shared
   React UI and an authenticated agent. Restart, disconnect, and backup/restore
   preserve the documented access and data-lifecycle behavior.
4. OSS and hosted cloud execute the same core-owned noncommercial UI and product
   operations. Cloud retains WorkOS authentication and composes hosted workspace
   selection and billing through explicit adapters and the shared design system.
5. The proprietary shell owns hosted tenant provisioning, routing, commercial
   policy, managed infrastructure, fleet operation and internal administration.
   A core contributor can build, test and operate the OSS app without that repo.
6. An isolated cloud candidate passes real source-to-retrieval, two-tenant
   isolation and rollback checks, without altering existing production data.

## Evidence and limits

Run `npm test`, `npm run check --prefix web-v2`, and
`npm run test:browser --prefix web-v2`. CI additionally exercises real Temporal,
S3-compatible storage and OpenSearch. CLI changes require its typecheck, tests,
build and cross-platform smoke suite. Full-application upgrade CI starts immutable
older releases, preserves their accounts and data, resumes an injected migration
failure through normal startup, and restores the matched old runtime and stores.

Use the [development installation checks](dev-install-acceptance.md) and
[self-host guide](self-host.md) for clean-machine verification. Verify a fresh
account's first-use flow and the actual public install artifacts before release.
A successful catalog listing or completed Airbyte job alone is not retrieval proof.
Google Drive is currently unavailable because its indexing path is incomplete;
its presence in the catalog is not a claim of support.

Keep operator addresses, private infrastructure receipts, credentials and
historical rollout worklogs outside the public distribution. Publication also
requires review of reachable Git history, licenses and dependency notices,
public artifact access, vulnerability reporting and fork CI policy. Repository
visibility and production promotion are separate actions from candidate tests.
