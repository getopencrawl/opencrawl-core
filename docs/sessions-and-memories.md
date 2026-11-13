# Sessions and memories

The console's **Sessions** and **Memories** pages let people read what their
agents captured and control who else can.

- **Sessions** lists captured sessions newest first, with a word search and a
  Participants column. Click a person to filter the list to their sessions;
  remove the chip below search to clear the filter. The URL retains search and
  participant selection across navigation, browser history and reloads.
  Opening a session shows its transcript: user and agent messages,
  collapsed tool calls and results, reasoning summaries and compaction notes.
  Thinking blocks, encrypted content and token accounting are never shown.
  Order and paging come from the index; text comes from the verified original
  capture batch.
  The Hostname column identifies the machine that captured the transcript, not
  necessarily where imported history originally ran. Missing hostnames appear
  as `—`. Sessions with more than one recorded hostname show **Multiple hosts**;
  the row tooltip and transcript metadata list the captured names. Up to 20
  names are returned, with an ellipsis when additional names exist. This uses
  existing indexed capture metadata and requires no backfill or new collection.
- **Memories** lists the current memory files agents keep (the newest copy per
  person, agent and path) with a readable title, and shows the full file.
  Titles use an explicit frontmatter title/name, a meaningful opening Markdown
  heading, a frontmatter description, then a filename with timestamp/ID prefixes
  removed and word separators expanded. Memory indexes and summaries keep their
  document-wide labels. Lists and viewers use the same bounded, read-time rule,
  so existing captures improve without reindexing or rewriting the source files.
  The original path remains visible and filtering includes titles and descriptions.
  Memory contents render as read-only Markdown, including headings, lists, code,
  links and GFM tables through the shared table component. Embedded HTML is not
  executed and remote images are not loaded. YAML frontmatter stays out of the
  rendered prose; View Markdown source reveals the complete, unchanged capture.
  Browser consumers install the pinned optional Markdown peers declared by core;
  `web-v2/package.json` provides them for the single-tenant console. Headless core
  installations do not require the renderer.

## Visibility

Everything is team-visible by default. The person who captured a session or
memory can mark it **private**. A private resource is excluded for everyone
else from these pages, workspace search and fetch (CLI, HTTP, MCP), the board's
recent sessions and transcript reads. Its owner still sees and searches it.
Usage counts remain aggregate and include private activity without content.

Each session you own has an eye toggle: an open eye means shared with
the team, and a crossed-out eye means private. Hover text names the action;
keyboard and screen-reader users get a labelled toggle with its current sharing
state. Visibility changes are shown only after the server confirms them.

Participants are display and filter identities, separate from capture ownership.
Human-owned captures use the uploader when no sender envelope exists. Replicas
messages use distinct reported human sender IDs and profile labels; shared
workload owners and unknown senders never become human participants. A session
can include several people. Filtering selects the whole session, so search can
match a message from a different participant. Participant IDs grant no access.

New captures index participant metadata automatically. Existing first passages
can be repaired with `migrateSessionParticipants` from
`@getopencrawl/opencrawl-core/sessions/participant-migration`. It defaults to a
dry run, uses bounded pages and a resumable cursor, verifies immutable sources,
and writes only missing participant metadata. It preserves text, token counts,
ownership, visibility and raw captures, and never recreates a deleted document.
Legacy human captures remain filterable by their owner during migration.

Visibility is stored as an owner control object beside the owner's capture
objects (`<prefix>/tenants/<t>/users/<u>/controls/{sessions,memories}/...`) and
copied onto every indexed document (`session.private`, `memory.private`). New
batches and snapshots are indexed with the current control; a change that lands
while a batch is indexing is reapplied after the write. Existing realms gain the
two boolean fields through an additive in-place mapping update.

## Deletion

Only the owner can delete. Other members receive "not found", so ownership of
another person's resource is never confirmed.

- Deleting a **session** permanently revokes reads and closes its durable write
  fence before cleanup. Search, fetch by ID, raw reads, the console and board
  discovery check authoritative owner controls, including after source reads.
  Failed storage or index access fails closed. Search documents are removed
  first; completion requires drained writers, removal of every raw batch,
  attachment and event-ledger version from every installation, and a refreshed
  empty search result. S3 delete markers alone are not erasure.
  Late live captures and history imports of the same tenant, owner, harness and
  native session ID return `stored: true, discarded: "session_deleted"` without
  storing content. Installation IDs do not reset deletion. No restore operation
  clears a tombstone. Other owners/tenants with colliding IDs are unaffected.
  New attachments require session identity. Legacy owner-scoped attachments
  referenced by the deleted session are also erased, even when another session
  referenced those same bytes. Unscoped attachment uploads are refused with an
  instruction to upgrade the CLI.
  `sessions/delete` authorizes the owner, persists a metadata-only deletion
  intent, revokes access immediately, and submits `deleteSessionV1` to Temporal.
  It returns `deleted: false, pending: true` while erasure runs. The UI removes
  the session after acceptance; it does not claim physical erasure is complete
  or expose storage cleanup controls. A repeated request after verified erasure
  returns `deleted: true, pending: false`.

  The durable workflow waits for fenced writers, scrubs historical archives,
  then erases raw versions and verifies the empty index before completing the
  permanent tombstone. Each stage retries independently with heartbeats and
  bounded attempt timeouts; worker/API replacement cannot lose the request.
  A separate deletion task queue prevents long archive scans from occupying
  indexing slots. A one-minute Temporal recovery schedule picks up persisted
  intents whose direct submission was interrupted. Intent keys and workflow IDs
  include the storage prefix, tenant, owner, harness and native session ID.
  Activities load the approved intent from the configured protected namespace;
  arguments cannot supply credentials, arbitrary owners or search/storage scopes.
  Accepted deletions continue if the owner later leaves the organization.

  An ambiguous remote write never expires into a claim of successful deletion.
  Operators inspect Temporal activity failures for unresolved writes, object locks
  or missing permissions. No cleanup error or transcript content enters the UI;
  Temporal history contains opaque references and sanitized error categories.
  The low-level `library.delete` helper remains for controlled operator erasure
  and upgrade verification; HTTP/RPC uses `library.requestDeletion` exclusively.

  **Upgrade:** deploy the new workflow bundle/worker and recovery schedule with
  the API scheduler wiring. For each known owner with a pre-upgrade pending
  tombstone, enumerate `library.pendingDeletions(owner)` and submit each through
  `library.requestDeletion(owner, session)`. This creates the new durable intent
  without clearing the existing tombstone or fence. Verify all such requests
  appear in Temporal; unresolved owner mappings must be reported, never skipped.
  Rollback must retain a worker that understands these workflow types until all
  accepted deletions complete. Do not roll back to a pre-fence writer.
- Deleting a **memory** removes the file's passages from search and ignores that
  version in later snapshots. The file on the person's machine is not changed;
  if the agent writes a newer version (later modification time), it is captured
  again. Raw snapshot objects are immutable and retain earlier versions.

The retained session control/fence contains IDs, hashes, timestamps and cleanup
state, never transcript or attachment bytes. Local harness files and independent
copies (including separate memory files or operator backups) are outside this
operation. Preserve current tombstones when restoring backups; never expose an
older backup or roll back to a pre-fence writer after deletion. See the
[upgrade and storage requirements](session-indexing.md#session-deletion-upgrade).

## API

Every runtime calls the same validated core operations
(`createLibraryApi` in `src/sessions/library-http.mts`) with a trusted principal.
The self-host MCP runtime serves them as `POST /api/library/<operation>`; the
self-host console proxies them as `/api/reference/library/<operation>`.

| Operation | Input |
| --- | --- |
| `sessions/list` | `scope` (`all`/`mine`), `query`, `limit` (1-500) |
| `sessions/read` | `userId`, `harness`, `sessionId`, `cursor`, `limit` (1-200) |
| `sessions/visibility` | `harness`, `sessionId`, `visibility` (`team`/`private`) |
| `sessions/delete` | `harness`, `sessionId` |
| `memories/list` | `scope` |
| `memories/read` | `userId`, `harness`, `path` |
| `memories/visibility` | `harness`, `path`, `visibility` |
| `memories/delete` | `harness`, `path` |

Capture-only credentials are refused. Ownership comes from the authenticated
principal; requests cannot name another owner for a change.
