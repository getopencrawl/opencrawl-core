# Google Drive workspace content

Drive uses the existing Airbyte → immutable gzip JSONL → connector worker →
organization search realm path. The source calls an operator-owned credential
proxy. Provider credentials and the current workspace roster remain at that
boundary; the source cannot choose a tenant or broaden its grant.

Before returning a file body to the source, the proxy reads its current metadata
and complete permissions. Every active OpenCrawl workspace member must have a
verified email covered by a current Drive content permission: an explicit user,
matching domain, or anyone permission. A shared drive ID, the connecting user's
access, and a group name alone are insufficient. Deleted, expired, metadata-only,
incomplete and unknown permissions fail closed. Group-only access is excluded:
the Drive grant does not include a Google Directory membership resolver.
The same policy is rechecked for search and fetch;
an old ingestion receipt never grants current access.

The initial body formats are Google Docs (Markdown), Sheets (all worksheets via
the Sheets API), Slides (text), and supported downloadable text/document
formats. Each returned document records its native ID, source version, canonical
link, original MIME type, complete extracted text, and a versioned scope-bound
permission receipt. Unsupported or oversized bodies are explicit source failures
or exclusions; a title does not stand in for a body.

The operator's identity directory must provide verified member emails. Local
password enrollment alone does not verify ownership of the corresponding Google
identity, and cannot authorize Drive content. This requirement also applies to
single-tenant deployments; missing identity evidence fails closed.

Full snapshots refresh permissions independently of file modification time.
New observations supersede old ones, including shorter edits. Derived passages
are published before the parent revision; old passages cannot pass the existing
parent-revision check. Source IDs are scoped by tenant, workspace and connection.
Legacy Drive streams lacking the permission receipt are never indexed.

Acceptance requires portable source/index/search tests, revoked and unknown
permissions, limited folders, paginated ACLs, membership changes, colliding tenant
IDs, stale and shorter edits, failed writes/replay, and a real authenticated
production search of a phrase from a permitted file body. Real source acceptance
must record its cutoff, supported formats and any excluded access patterns.
