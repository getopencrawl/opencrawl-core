# Global workspace connector indexing

The portable pipeline supports Slack, Granola, Circleback, Notion and GitHub.
Use the same standalone CLI or Temporal worker documented in
[connector indexing](connector-indexing.md). For the four new providers, the
operator-trusted binding must explicitly specify `access: "workspace-global"`,
the provider, tenant, workspace, connection and exact
`raw/v1/source=<provider>/workspace=<workspace>/connection=<connection>/` prefix.
This is an assertion by the trusted resolver that every selected resource is
team-visible, not a permission inferred from API credentials or connection scope.
The hosted resolver supplies this binding for active team connections and trusts
upstream ingestion to exclude non-global resources. Personal and
subteam resources require a future permission model and are not supported here.

## Indexed content

- Granola: `notes` title, summary markdown/text, date, attendees and source URL;
  `transcripts` speaker, text and start/end time. Private notes, attachments and
  recordings are excluded.
- Circleback: `meetings` name, notes, action-item title/text/description,
  assignee name and due date, date, attendees and URL; `transcripts` speaker,
  timestamp and text. Private notes and recordings are excluded. The hosted
  source must use Circleback's built-in Workspace folder.
- Notion: `pages` titles and typed property values; `page_markdown` content;
  `data_sources` title, description, property names/types; `comments` readable
  rich text with page/discussion IDs. Users are not hits. File property labels
  are included, not signed download URLs or binary bodies. Truncated markdown
  and unknown blocks fail visibly instead of acknowledging incomplete content.
- GitHub: commit messages, authors and dates; PR and issue titles, bodies,
  authors, labels and state; nested PR reviews; issue, review and commit comments;
  releases. Both GraphQL and REST review shapes are supported. Repository and
  resource IDs and URLs accompany the text. Files, patches, diff hunks,
  discussions, branch/tag snapshots and repository snapshots are not indexed.
  Only fields present in landed records can be indexed.

Small resources remain whole. Long text becomes sentence/heading-aware passages
targeting 512 estimated tokens, with up to 100 estimated tokens of overlap when
sentence boundaries permit. Oversized sentences split at words. Estimation uses
UTF-8 bytes and word count; this is not a model-specific tokenizer. Meeting
summaries remain their own documents; transcripts always form linked passages.
Each passage carries provider/workspace/connection, parent kind/ID, source URL,
title, revision, sequence and chunk count. Transcript passages also carry speakers
and start/end timestamps. These fields support grouping and neighbor expansion.

## Assembly, ordering and replay

GitHub streams use bounded per-object processing and successful-object receipts.
Granola, Circleback and Notion use one bounded connection snapshot activity so
object rotation cannot split a meeting or change chunk boundaries. It inventories
selected immutable keys, skips an already-acknowledged inventory, and otherwise
streams them into an accumulator retaining latest source versions. Transcript
segments at that version are deduplicated by time/speaker/text and sorted by time.
Ties sort deterministically. Sources without segment identities cannot distinguish
two identical utterances by the same speaker at the exact same timestamp.

The first implementation bounds snapshots at 10,000 objects and 128 MiB retained
records. A changed inventory rereads selected raw objects. Larger connections
must be partitioned before enabling this path; the worker fails rather than
silently truncating. GitHub does not use that in-memory snapshot path. All reads
are streaming, capped at 256 MiB compressed, 1 GiB expanded per object (2 GiB for GitHub) and 16 MiB
per line. This admits the GitHub source's bounded diffs while discarding them
before indexing. Temporal heartbeats cover I/O; activities retain the existing
10-minute timeout and bounded concurrency.

Children commit before their parent publishes the current revision. Search
validates scope and checks every passage against its current parent revision;
old passages cannot leak through normal or raw results. Source revision precedes
observation time in update ordering. Same-time late assembly uses component count
before deterministic content hash. Shorter edits at a newer source revision win.
Receipts acknowledge successful complete writes only and include source checksums
(an aggregate checksum for snapshots). If the inventory changes during a build,
the activity retries instead of acknowledging it. Usage counts source entities,
not retained passage versions. This release adds no source-deletion inference.

Slack retains its independent normalization version, IDs, receipt paths and
public-channel check. New fields are additive to its strict OpenSearch mapping;
existing field type mismatches still fail. A Slack normalization upgrade still
requires its own generation migration, independently of enabling new providers.

## Verification

`npm test` exercises scopes, real source shapes, cross-file assembly, ordering,
chunk coverage, replay, failures and content exclusions without hosted services.
CI also runs `test/connector-live.test.mjs` against disposable S3/OpenSearch. It
indexes and queries each provider, checks same-time enrichment, shorter edits,
stale updates, cross-tenant rejection and retained-passage filtering. Hosted
acceptance must additionally verify current connection authorization, schedules,
actual raw schemas and authenticated product queries. Fixture success alone is
not proof of upstream extraction completeness or global source permissions.
