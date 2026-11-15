# Search defaults and native chat identity

Agent search excludes session tool/command output by default. With a valid
`currentSession: {harness, sessionId}`, it also excludes that exact calling chat.
The runtime supplies tenant and capture owner from authentication. Native identity
is a retrieval preference, never authorization. The exclusion matches the whole
owner/harness/session tuple; it ignores installation ID so duplicate captures on
other machines remain excluded. Parent, sibling and fork chats remain searchable.

Use `includeToolOutputs: true` for logs, errors, tests and execution receipts.
Use `includeCurrentSession: true` to include the asking chat. Explicit kind,
role and tool-name filters intersect the defaults; they do not override them.
Search responses include `searchContext`, including `currentSessionStatus`:
`excluded`, `included`, or `unavailable`. Missing native context does not guess a
chat: search continues and reports that self-chat exclusion was unavailable.
Check this status before concluding that a search covered the current chat.

Both constraints apply inside the authorized session query before the candidate
limit, ranking, facets and grouping. Cursors bind the context and inclusion
options. Connector and memory documents retain their existing semantics. Captures
are not deleted, and authorized fetch-by-ID remains available. A tool result
quoted inside another ordinary message is not automatically removed.

## Client attachment

A synchronous native pre-tool hook merges the native chat identity into the
original `opencrawl_search` arguments on each request. Hooks target only this new
alias, which older servers do not advertise, so a CLI upgrade cannot inject new
arguments into an older server's strict `search` schema. It does not read credentials,
transcripts, a global current-chat file or the latest board registration. Two
concurrent chats can therefore share credentials without sharing caller context.
Disabled or unapproved hooks remain disabled; setup does not grant trust or
change permission policy.

After a newer CLI has been installed, its next existing capture hook or session
startup refreshes already-installed OpenCrawl skills and native search hooks
locally. Ordinary CLI commands also refresh them. Publication alone does not
activate a client, and a running process keeps its loaded binary. The refresh
uses a nonblocking lock and a short cooperative budget, retries on a later event
when busy, and caches a completed version/revision to avoid per-event writes.
It performs no network or sign-in work. `OPENCRAWL_NO_UPDATE=1` disables automatic
refresh; `opencrawl skills refresh --json` explicitly retries it. Refresh does
not create a first skill installation: use `opencrawl skills install` for a client
that has never installed the skill. Disabled hooks, managed-only policy and an
existing hook's different OpenCrawl profile remain preserved.

Codex requires normal review of the new **OpenCrawl search context** hook in
`/hooks` or desktop Settings > Hooks; review it and start a new session. The
installer never grants trust. Claude normally watches hook settings for changes;
when its SessionStart refresh changes guidance, it requests the documented
`reloadSkills` rescan. Cursor reloads changed hook settings; restart if the
adapter is not loaded. Start a fresh Antigravity session after activation;
`/skills reload` refreshes its CLI skill list, but we have not verified that it
reloads hooks in an already-running session. Reconnect MCP or start a new session
if the client still lacks the server's new tool alias. These are host activation
steps; inspect `searchContext.currentSessionStatus` on an actual search to verify
that identity attachment is active. See the native [Codex hook review](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks),
[Claude hook reload](https://code.claude.com/docs/en/hooks#reload-skills-that-a-hook-installs),
[Cursor hooks](https://cursor.com/docs/hooks), and
[Antigravity skill discovery](https://antigravity.google/docs/customization-discovery) references.

Prefer `opencrawl_search`; `search` is the compatible existing alias. Both execute
the same server operation. Cursor's pre-tool event omits the MCP server name,
so its adapter requires the unique `opencrawl_search` name. It never rewrites
another service's bare `search` arguments. Cursor cloud HTTP-MCP execution ignores
argument rewrites; that path reports missing context rather than claiming
automatic exclusion. Google-managed Antigravity Remote Agents do not load the
local MCP/hooks configuration; Antigravity Remote Control retains local execution.
These managed cloud surfaces are outside native-hook support. A generic MCP client without a native hook can supply the
exact context explicitly but does not gain automatic identity attachment.

CLI equivalents are `--include-tool-outputs`, `--include-current-session`, and
`--current-session '{"harness":"codex","sessionId":"native-chat-id"}'`.
Workspace and user are never passed in this argument.

## Existing data

Every newly indexed session passage includes `containsToolOutput`, derived from
structured capture kinds/content blocks. This covers Claude result blocks inside
user-role messages as well as canonical result events from other clients. A mixed
human-text/result event is excluded as a whole unless tool outputs are requested.
Classification does not rely on words in text and does not change the original
message. Known legacy result kinds are filtered before migration; ambiguous
historical content blocks require the metadata backfill below. During rollout,
`searchContext.unclassifiedSessionCandidates` counts candidates without the new
metadata and an explicit warning reports possible legacy embedded tool output.
This count describes the bounded query window, not the entire corpus.

Deploy updated indexing workers first, then call `migrateSessionSearchContext`
from `@getopencrawl/opencrawl-core/sessions/search-context-migration` with the
canonical tenant realm, object store and capture prefix. Dry-run is the default.
Use bounded `maxPassages` and persist the `after` cursor via `onPage`; resume
until `complete`. The migration validates each original capture's scope and
patches only missing classification metadata, preserving text, IDs, visibility
and immutable source captures. Deletion fences prevent resurrection. Errors stop
the page instead of guessing from unavailable source data.

The metadata is additive: older readers ignore it. Runtime rollback therefore
uses the previous tested release without deleting or restoring captures. Inspect
all migration receipts and remaining unclassified counts before claiming that
historical tool output is fully filtered.

Administrator-managed Codex SessionStart configuration does not imply a managed
search-context hook. If policy allows only managed hooks, the administrator must
install the corresponding synchronous `PreToolUse` invocation of
`opencrawl search-context --harness codex` for the exact new tool alias. Setup
preserves that policy and does not approve hooks on the administrator's behalf.
