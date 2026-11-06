# Building a connector-to-search pipeline

Use this guide together with [the architecture contract](../ARCHITECTURE.md) and
[the current Slack indexing implementation](connector-indexing.md). Connecting a
source to an object store does not make it searchable. Extraction, normalization,
authorization, indexing, and retrieval each need an explicit contract and evidence.

## Reuse the processing path, specialize source semantics

Keep one implementation of bounded object reading, bulk writes, retries, receipts,
and durable workflow orchestration. Put provider-specific record interpretation,
identity, source-version ordering, and access rules in a core adapter. The hosted
shell resolves managed credentials and current tenant membership; it does not
contain an alternative normalizer or search permission model.

The runtime supports Slack and explicitly authorized global Granola, Circleback,
Notion and GitHub resources. See [workspace connector contracts](workspace-connectors.md)
for species, chunking, update ordering, resource scope and bounded assembly.
Adding a provider to extraction alone does not enable search. Keep each adapter's
access semantics explicit; Slack's `team-public` is not a general workspace grant.

Use the same persistent Temporal service for connector orchestration, separate
from an extractor's internal workflow service. Start with shared worker code and
bounded concurrency. Separate task queues and worker processes when a provider
needs a distinct runtime, memory limit, rate budget, rollout, or failure boundary.
Do not copy the whole pipeline per connector. Process separation does not replace
resource authorization, and a shared process must never use mutable global scope.
Workflows carry references and cursors; activities perform storage/network I/O.
Raw records, credentials, and message text stay out of workflow history.

For Slack, [canonical history capture](slack-message-capture.md) supplies a
cursor-exhaustive source alongside search-based feeds. Explicit source authority
prevents later previews from replacing canonical text; observation ordering
within that authority still permits shorter edits. Treat API representation
differences as evidence to investigate, not proof of truncation or completeness.

## Write the source contract before implementing the adapter

Record these decisions with the adapter's fixtures:

| Contract | What must be specified and verified |
| --- | --- |
| Extraction | Actual connector/version or manifest hash, enabled streams, selected fields, transforms, sync modes, cursors, lookback, backfill boundary, source API limitations |
| Landing | Object-store format and compression, envelope field types, exact scoped prefix, partition grammar, immutability, and maximum supported sizes |
| Identity | Provider/workspace/connection scope, native resource ID, document kind, aliases, parent/child relationships, reconnect behavior |
| Content | Which fields hold readable content, fallback versus primary body, blocks/attachments, encoding, links, truncation indicators, supported and excluded attachment content |
| Updates | Source revision or observation time, equal-version tie handling, partial versus complete records, late arrivals, edits outside lookback, and enrichment precedence |
| Access | Who may retrieve each resource; permission evidence, missing metadata, revocation, and refresh/reconciliation semantics |
| Deletion | Authoritative deletion signal, suppression behavior, raw retention, derived erasure, and what absence does or does not establish |

Inspect the live configured source and destination as well as the checked-in
manifest. A successful extraction job can still use an old catalog, omit fields,
coerce values, or emit only previews. Keep exact string IDs and timestamps where
precision matters. Validate required envelope/data types before indexing; an
Airbyte `_airbyte_meta.changes` entry can signal loss even when JSON is valid.
Unknown streams may be deliberately skipped, but count them. A malformed selected
stream must fail visibly without a success receipt.

## Prove readable-content completeness separately from delivery

For representative long messages, replies, edited records, bots/app posts,
block-only messages, and attachments, compare three things: the source response,
the immutable landed record, and the resulting searchable document. Counts and
matching top-level `text` hashes prove delivery, not full readable content.

Slack illustrates the distinction: `text` can be an accessibility/notification
fallback while richer content lives in `blocks` or `attachments` (see
[Slack’s field semantics](https://docs.slack.dev/reference/methods/chat.postMessage/)). An ellipsis
alone does not establish truncation, and a second API request or a stream named
“restored” does not establish restoration. Check the relevant source fields and
verify that a phrase from the actual body, beyond any preview, is searchable.
Use synthetic examples in committed fixtures; retain aggregate counts, hashes,
and provenance for live checks rather than copying customer messages into Git.

For full document bodies and API file comments, see the portable
[Slack file capture contract](slack-file-capture.md). It is a separate source
operation; message previews do not stand in for downloaded documents.

Define a deliberate content policy. Do not recursively index every string in an
arbitrary provider object: tokens, URLs with credentials, hidden metadata, and
unrelated fields are not message body text. Include supported visible fields in
a stable order, bound the combined size, and document unsupported media or binary
file bodies. Do not silently truncate an oversized record and acknowledge it.

A later partial/preview observation must not silently replace an earlier full
body merely because it was extracted later. Conversely, keeping the longest text
forever would discard legitimate shorter edits. Specify source-version and
completeness semantics together, then test both cases.

## Carry trusted scope through every operation

The runtime resolves the authenticated principal and active connection into a
binding. The binding fixes provider, tenant, owner/workspace, connection, access
policy, raw prefix, and index target. Client bodies, queued payloads, URLs, and
source content cannot choose those values. Re-resolve current authorization on
activity retries and before writes/receipts; fail closed when ownership changes.

Core validates scope before object listings, reads, writes, search, exports, and
deletion. IDs and receipts must not collide across tenants or reconnects. Include
provider identity when generalizing beyond the current Slack-only ID namespace.
Validate returned search ownership as well as adding filters to the request.
Recheck access at retrieval; filtering only during ingestion leaves stale access.

Choose provider access semantics explicitly. A user's mailbox is not readable by
all coworkers. A workspace-shared note is not equivalent to every note reachable
by an API key. Repo/page access can differ among members of the same company.
Implement the required resource permission model before enabling such content.
Single-tenant deployments still need an operator-controlled access policy and
authentication before exposing a network endpoint.

## Make replay converge without hiding failure

Treat raw objects as immutable. Preserve originals and append corrections under
new keys. A receipt is scoped to the pipeline interpretation version, connection,
raw object, and index identity. Write it only after every bulk item succeeds;
HTTP success alone is insufficient. Record the source checksum and record count.
Never restore receipts without their matching index or accept a receipt for a
replaced object. Audit checksums to test the immutability assumption.

Use stable native identity and atomic destination-side version comparisons so
retries, aliases, and out-of-order objects converge. Keep explicit suppression
sticky across replay. Do not infer source deletion or permission revocation from
an incremental file's absence; complete snapshots need a separately specified,
verified reconciliation protocol before absence can carry that meaning.

Bound decompression, lines, records, bulk payloads, scan pages, activity concurrency,
and workflow history. Heartbeat long work, retry transient failures, reject
permanent schema/scope failures visibly, and continue independent files so one
poison object does not starve the connection. The scheduled sweep should still
report failures. Monitor lag as well as process health.

For changed normalization or mappings, plan reindexing explicitly. Old receipts
can skip already-landed objects; equal observation timestamps and hash tie-breaks
can also prevent changed documents from replacing old ones. Prefer a new index
generation with its own receipts, carry forward authoritative suppression/access
state, verify it, then switch retrieval with a rollback target. Do not assume
raw source files alone contain operator suppression decisions.

## Acceptance gates for each new provider

1. **Source contract:** verify live manifest/catalog/destination and raw envelope,
   field types, paths, source identity, and permission metadata. State coverage
   boundaries and exclusions instead of claiming all source history was fetched.
2. **Portable path:** index and query with only core plus customer-controlled
   object storage, OpenSearch, and optional Temporal. No hosted account or secrets.
3. **Delivery and content:** compare landed object hashes/counts with receipts,
   reconcile unique native IDs with indexed documents, and test readable-content
   extraction against source fields. Probe long-body suffixes, aliases, and replies.
4. **Isolation:** two tenants with colliding source IDs; forged/missing scope;
   wrong connection/workspace; private/unknown permission metadata; revoked access.
   Exercise allowed and denied reads, writes, search, and queued work.
5. **Updates and replay:** duplicate files, stale arrivals, equal-version conflicts,
   late enrichment followed by a preview, legitimate shorter edits, tombstones,
   new generations, and partial bulk failures. Replays must not duplicate documents.
6. **Recovery:** crash after committed writes but before the receipt, restart the
   worker and durable orchestration service, then prove one final document,
   a correct receipt, and replay-compatible workflow history.
7. **Hosted path:** source → immutable raw object → scheduled activity → index →
   actual authenticated API/UI query. A privileged direct OpenSearch query or MCP
   connectivity check does not prove the authenticated product path.
8. **Operations:** observe completion/failure/lag, verify deploy and rollback,
   remove owned synthetic fixtures, and preserve dated evidence with immutable
   source/package/image revisions. Distinguish fixtures from real-source checks.

Run `npm test` and the service-backed connector tests in CI. Publish a tested,
immutable core runtime version before a hosted consumer updates package, lockfile,
and source pin together. Documentation-only changes need no runtime publication.

### Proving complete text coverage

S3-to-index equality proves transport and normalization of landed records. It
cannot establish source completeness. A complete-coverage claim additionally
needs an independent source inventory under the connection's actual identity:

- Record the source workspace, active connection, granted scopes, cutoff time,
  configured backfill range, retention restrictions and source API versions.
- Enumerate every authorized container, including archived containers. Exhaust
  cursors for history, replies and attachments; an empty or short page is not an
  end marker. Keep a durable per-page checkpoint and honor `Retry-After`.
- Cross-check alternate discovery surfaces such as pinned items, container tabs,
  attached canvases and linked lists against the primary inventory. Record absent
  scopes and API permission failures explicitly; they do not prove an empty
  resource set. Do not follow arbitrary external links or broaden authorization.
- Reconcile native IDs, full readable fields and attachment bodies against raw
  records, normalization receipts and indexed bodies. Preserve both the source
  field path and content hash. Menus, labels, descriptions, accessibility text,
  tables and attachment previews must be accounted for rather than silently
  excluded because they are not the message's top-level `text`.
- A file title is not a file-body import. Inventory files separately, record
  download and extraction outcomes, and verify every supported text-bearing
  part. Treat permissions, unsupported formats, pagination errors and rate
  limits as explicit unresolved coverage gaps, not successful empty results.
- Prove that authenticated retrieval can search the resulting text within its
  current resource visibility. Recheck access when source content changes;
  never widen a public-channel connector to private channels merely because
  the OAuth token also has private-channel scopes.

Report a cutoff and per-stage numerator/denominator. If the provider does not
support consistent snapshots, record the observation window and reconcile
edits/deletions during that window. Preserve prior evidence as a dated baseline;
never relabel a sample audit or a 90-day backfill as complete source coverage.

Compare alternate API representations in both directions before assigning source
authority. A synthesized fallback may join adjacent fields into artificial words;
an older search snapshot may contain text removed by a later edit. Preserve exact
provider pages and the deployed transformation, reconstruct the synthesized value,
and compare the original readable fields and edit/observation times. Do not union
old and new bodies or choose the longest body to make a coverage check pass.

Keep source enumeration, committed raw records, acknowledged index records and
authenticated retrieval as separate gates. During an active crawl, a new page
without a receipt is pending indexing; a receipted record with different content
is an integrity failure. Freeze a completed run for receipt reconciliation so a
subsequent scheduled run does not create a false missing-receipt denominator.
Record semantic parser checks separately from exact transport hashes: a second
PDF extractor can expose broken words or reading order, but its own layout
artifacts also need classification against the source page.
