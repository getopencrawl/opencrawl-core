# Sessions and memories

The console's **Sessions** and **Memories** pages let people read what their
agents captured and control who else can.

- **Sessions** lists captured sessions newest first, with All and My tabs and a
  word search. Opening a session shows its transcript: user and agent messages,
  collapsed tool calls and results, reasoning summaries and compaction notes.
  Thinking blocks, encrypted content and token accounting are never shown.
  Order and paging come from the index; text comes from the verified original
  capture batch.
- **Memories** lists the current memory files agents keep (the newest copy per
  person, agent and path) with their description, and shows the full file.

## Visibility

Everything is team-visible by default. The person who captured a session or
memory can mark it **private**. A private resource is excluded for everyone
else from these pages, workspace search and fetch (CLI, HTTP, MCP), the board's
recent sessions and transcript reads. Its owner still sees and searches it.
Usage counts remain aggregate and include private activity without content.

Visibility is stored as an owner control object beside the owner's capture
objects (`<prefix>/tenants/<t>/users/<u>/controls/{sessions,memories}/...`) and
copied onto every indexed document (`session.private`, `memory.private`). New
batches and snapshots are indexed with the current control; a change that lands
while a batch is indexing is reapplied after the write. Existing realms gain the
two boolean fields through an additive in-place mapping update.

## Deletion

Only the owner can delete. Other members receive "not found", so ownership of
another person's resource is never confirmed.

- Deleting a **session** first writes a tombstone, then removes every capture
  batch and event ledger for that session from every installation, then removes
  its search documents. Uploads of the same session that arrive later are
  acknowledged (`stored: true, discarded: "session_deleted"`) so clients stop
  retrying, but are never stored or indexed. Content-addressed attachments may be
  shared with other sessions and are retained.
- Deleting a **memory** removes the file's passages from search and ignores that
  version in later snapshots. The file on the person's machine is not changed;
  if the agent writes a newer version (later modification time), it is captured
  again. Raw snapshot objects are immutable and retain earlier versions.

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
