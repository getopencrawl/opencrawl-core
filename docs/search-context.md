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
Prefer the advertised `opencrawl_search_v1` tool, then `opencrawl_search`, then
`search`, and send only arguments exposed by the selected tool schema. Older
fallback servers may lack these defaults or context options. If `searchContext`
is absent, default exclusions and current-chat exclusion are unconfirmed.

Both constraints apply inside the authorized session query before the candidate
limit, ranking, facets and grouping. Cursors bind the context and inclusion
options. Connector and memory documents retain their existing semantics. Captures
are not deleted, and authorized fetch-by-ID remains available. A tool result
quoted inside another ordinary message is not automatically removed.

## Client attachment

A synchronous native pre-tool hook merges the native chat identity into the
original `opencrawl_search_v1` arguments on each request. The versioned alias
is advertised only by servers supporting these context options. Antigravity
uses only this alias for automatic identity after the CLI update: its native
plugin prefixes can make the older `opencrawl_search` name indistinguishable
from a plugin's legacy `search` tool. Claude, Codex and Cursor also retain their
unambiguous older `opencrawl_search` adapter names for compatibility. Hooks never
target a bare legacy `search` tool or add arguments based only on an older
server's name. The hook does not read credentials,
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

The three search aliases execute the same operation on updated servers. Prefer
`opencrawl_search_v1`; reconnect MCP if its tool list is stale. Older aliases
remain available, but do not assume automatic attachment or default exclusions
without the response's `searchContext` report. Cursor's pre-tool event omits the
MCP server name, so its adapter selects the unique OpenCrawl alias names. It never rewrites
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
canonical tenant realm, authoritative `ApplicationState`, raw object store and
capture prefix. Supply the state from the same configured installation and source
binding: its resource controls and write fences govern the migration. Dry-run is
the default.
Use bounded `maxPassages` and persist the `after` cursor via `onPage`; resume
until `complete`. The migration validates each original capture's scope and
patches only missing classification metadata, preserving text, IDs, visibility
and immutable source captures. Deletion fences prevent resurrection. Errors stop
the page instead of guessing from unavailable source data.

The classification metadata is additive: older search readers ignore it, so
rolling back this search feature requires no capture deletion or restoration.
If the deployment also changed the authoritative application-state backend,
follow that cutover’s rollback procedure and use a runtime compatible with the
current state backend. Do not restart legacy S3 control or fence writers after
PostgreSQL becomes authoritative. Inspect all migration receipts and remaining
unclassified counts before claiming that historical tool output is fully filtered.

Administrator-managed Codex SessionStart configuration does not imply a managed
search-context hook. If policy allows only managed hooks, the administrator must
install the corresponding synchronous `PreToolUse` invocation of
`opencrawl search-context --harness codex` for the exact new tool alias. Setup
preserves that policy and does not approve hooks on the administrator's behalf.
