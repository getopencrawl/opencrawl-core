# Native agent memory

Installed collectors check for memory work on normal CLI invocations. Each
enrolled harness refreshes at most once every six hours after its last successful
scan. There is no refresh setting, user command, timer, or installed service.
Work overlaps the invoking command, has a 90-second bound, and is cancelled when
that command exits. Short commands can leave it due; managed async capture hooks
provide longer execution windows. Offline or failed refreshes retry on subsequent
invocations after a fixed 15-minute backoff. This is best-effort freshness, not a
six-hour delivery guarantee while the host is idle.

Local-only legacy hooks, dry-run previews, logout and uninstall never start network
refresh work. Capture project/session exclusions pause memory refresh: consolidated
native files can combine excluded and included sessions without enough provenance
to separate them safely. Existing uploaded snapshots remain unchanged, matching the
capture exclusion contract. Uploads recheck enrollment under the capture upload
lock before sending bytes, so a committed exclusion/uninstall fences memory too.

The collector discovers Markdown in Codex `memories/` and `memories_v2/`, Claude
`projects/*/memory/`, user `agent-memory/`, and the user-configured
`autoMemoryDirectory`. Enrolled Claude hook working directories also supply their
fixed `.claude/agent-memory/` and `.claude/agent-memory-local/` directories. It does
not reverse Claude's lossy encoded project names or follow repository-supplied
custom memory paths. Both Codex stores retain their distinct paths. Memory files
are evidence, not executable instructions. Hidden directories, symlinks, raw
consolidation scratch and instruction files are excluded. Reads are bounded and
checked for concurrent changes. A missing known root must be absent on two
complete discoveries before its removal can publish; an unreadable base fails.

Snapshots are scoped to authenticated tenant, uploader, installation and harness.
They contain exact Markdown, relative source path, project, file modification
time, host and a monotonic generation. The SHA-256 receipt covers the full JSON
snapshot. A local successful hash suppresses unchanged uploads. A kernel-backed
local lock prevents overlapping refreshes. Only successful receipts advance
changed content; cancelled/failed scans preserve the last successful state.

`POST /api/sessions/memories` shares the authenticated capture receiver in both
self-hosted and hosted runtimes. Upload-only capture credentials may write but
cannot search. Immutable gzip objects live below the existing session namespace:

`<prefix>/tenants/<tenant hash>/users/<user hash>/memories/<harness>/<installation hash>/<generation>-<snapshot hash>.json.gz`

The existing session Temporal workflow discovers these objects and verifies both
their content hash and stored namespace before indexing. No raw memory content
enters workflow history. Snapshot limits are 32 MiB, 4096 files and 2 MiB per file;
exceeding a limit fails the snapshot instead of silently truncating it.

The shared organization realm adds a `memory` corpus using an additive,
tenant-verified mapping. It writes every new passage, refreshes those writes, then
atomically publishes one snapshot head per uploader/installation/harness. A
generation comparison prevents stale retries from replacing newer heads. Search
and fetch select only the published heads; removed files and all old revisions
disappear together. Empty snapshots remove all current files for that source.
Immutable source snapshots and superseded index passages remain available to
operators for recovery, but normal retrieval never returns them. Memory histories
do not increment session counts or appear as synthetic chats.

CLI, HTTP, MCP and the workspace's shared search include memories. `source=memories`
narrows a query. Fetch returns the original indexed passage and provenance,
including a source session ID where the file supplies one. Reads are team-wide
inside the authorized tenant, just like captured sessions, unless the uploader
marks a memory private (`docs/sessions-and-memories.md`). Current scope and
visibility are checked on every search/fetch.

Release the tested core package before updating the hosted package/lock/Git pin.
Publish CLI 0.4.19 before the hosted rollout exposes its pinned cloud setup script;
early clients retry against the old receiver without losing their local memories.
Existing session and connector documents are preserved.
Rolling back to the prior CLI stops new scans; prior server code ignores the new
object paths and mapping fields. Retain source objects and indexing receipts.
The memory mapping adds no index, cluster, daemon or infrastructure service.

## Rebuilding memory passages

Passage identities now include a projection ID derived from the immutable
snapshot hash and passage format version. Existing heads without a projection ID
continue selecting only legacy passages. A reindex stages separate documents,
checks bulk completion and refresh, then atomically switches the head. Partial
writes remain invisible. A newer captured generation wins over an older reindex,
including when it arrives between the head read and activation. Snapshot bytes,
generation, received time and capture receipts do not change.

The portable `memories/projection-migration` export provides
`migrateMemoryProjection` and `rollbackMemoryProjection`. Supply an explicitly
tenant-bound realm, trusted tenant principal, object store and prefix. Process
one head per call; both operations default to dry run. The migration validates
the head identity, immutable object namespace, snapshot hash and capture time
before writing. Before applying, persist the provided backup under the same
tenant's operator recovery policy. Key it by head and replacement projection and
retain the first value on retries. It contains the old head, compressed source
hash and retained passage count, without another copy of memory text.

An applied migration returns `activated`, `superseded` by a newer capture, or
`already-current`. Check the active head and search/fetch results after each
bounded batch. Keep old passages and source objects until the rollback window
closes. Rollback validates the backup, immutable source and retained passage
count, then conditionally restores the pointer only while that exact replacement
projection remains active. A newer capture cannot be overwritten, including if
it publishes during rollback. Owner deletion can remove retained passages and
make rollback unavailable; deletion takes precedence over recovery.

Search, fetch and library reads recheck current owner visibility and deletion
controls, so stale staged or restored passages cannot undo a later privacy change
or deletion. A deleted file becomes readable again only after a later file
modification, following the existing memory contract. The library reads one
complete active file and rejects missing chunks rather than returning a
truncated file.

This rollback restores a projection using the projection-aware reader. It does
not make an older binary safe: readers predating projection IDs select all
passages for a snapshot and can mix retained and replacement chunks. Keep a
projection-aware runtime during recovery. Before any downgrade to an older
reader, stop memory writers and reconcile every active snapshot and retained
projection to that reader's format; validate complete file reads before serving
traffic. An image rollback alone is insufficient after projection activation.
