# Direct Replicas history import

In **Integrations → Replicas → Import history**, an OpenCrawl workspace admin
pastes a Replicas **organization API key**, reviews the organization name and
retained conversation inventory, and explicitly starts the import. No Composio
or Airbyte connection is involved. Personal API keys and CLI tokens are rejected.

The importer uses only GET requests to `https://api.replicas.dev`, pins
`X-Replicas-Api-Version: 2026-10-07`, and refuses redirects. It pages
`/v1/organization/conversations` with `next_cursor` and each
`/v1/replica/{id}/history` with `before_cursor`. Reading retained history does
not wake sleeping or archived replicas. The export's total describes its
inventory; it is not evidence that every listed history is readable.

An organization key can read organization-owned workspaces. Reading personal
workspaces also requires **Team workspace visibility** in Replicas. Export
inventory can include chats whose history returns 404 to the key. Enabling
visibility also lets organization members see one another's workspaces; the
importer explains the setting and never changes it. An all-unavailable scan
reports **No messages were imported**, not a successful data import.

This version imports **Claude and Codex text conversation messages**. Tool
traces, reasoning, attachments, and other providers are excluded. Imported
sessions are team-readable and titled `[Replicas history] …`. Message authors
remain unknown; the importing admin is not presented as their author.
Repeated historical imports use deterministic event IDs. Native live captures
use different IDs and can overlap: this is disclosed before consent.

Each browser request processes one history page. Keep the dialog open to run;
closing it pauses after the current request. Any current workspace admin can
resume. PostgreSQL holds the checkpoint and an AES-256-GCM encrypted key,
bound to the runtime namespace and tenant. A per-tenant transaction lock
serializes concurrent import requests. Checkpoints advance only after the
normal session ingest accepts the batch and its indexing handoff. The key is
removed on completion or **Remove key**; imported history remains.

A first-page 404 or 409 is counted as unavailable. Unsupported providers and
empty conversations are counted separately. Transient failures, missing or
repeated cursors, and failures midway through a conversation pause without
advancing the checkpoint. Resuming retries the same immutable batch.

Self-host startup derives a dedicated encryption key from the operator's
stable auth secret via HKDF, scoped to the application database namespace.
Rotating that secret requires removing/re-entering keys for unfinished imports.
The hosted adapter supplies its own stable secret and existing scoped database.
Both use the existing session store and search realm, with normal Temporal
indexing in deployed runtimes.

## Branch verification

`tools/replicas-import-preview.mts` is a loopback-only disposable fixture,
requiring `OPENCRAWL_TEST_POSTGRES_URL`, `REPLICAS_PREVIEW_ORGANIZATION_ID`, and a task-owned
`REPLICAS_PREVIEW_ROOT=/private/tmp/replicas-backfill-…` directory. It accepts
only the explicitly selected Replicas organization, uses real local account
authorization, and indexes into an isolated SQLite realm synchronously. Its
one-shot `/__branch_test_login` is a test-only login; never deploy this fixture.
No hosted production object store or search index is used. Remove the temporary
key in Replicas after verification and stop/remove the task-owned fixture data.

References: [organization export](https://docs.replicas.dev/api-reference/replica/list-organization-conversations),
[history pagination](https://docs.replicas.dev/api-reference/replica/read-history),
[identity](https://docs.replicas.dev/api-reference/organization/get-current-identity).
