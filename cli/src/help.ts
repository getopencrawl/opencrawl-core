const common='\nOptions: --json (versioned JSON), --api https://host (deployment), --help.\n';
export function commandHelp(command:string, operation?:string):string|undefined {
  if(command==='search')return `Usage: opencrawl search "keywords" [options]

On supporting servers, defaults exclude session tool/command output and the
current chat when its exact native identity is supplied. Check data.searchContext:
currentSessionStatus=unavailable means the calling chat was not excluded.
If searchContext is missing, defaults and current-chat exclusion are unconfirmed.
The three context options below require server support; never infer legacy defaults.

  --include-tool-outputs            Include logs, errors and execution receipts
  --include-current-session         Include the calling chat
  --current-session JSON            {"harness":"codex","sessionId":"native-chat-id"}
  --source all|sessions|connectors|memories
  --match any|all|phrase            Default any; all requires every term
  --session-id ID                  Search only this session (--source sessions)
  --filters JSON                   Exact provenance filters
  --order relevance|newest|oldest   Empty query allowed with time order
  --limit 1..40                    Default 10
  --facets source,kind,harness     Counts over authorized candidates
  --select title,text,provenance   Omit text for discovery, then fetch evidence
  --group-by resource|session|none Default resource
  --excerpt-chars 100..2000        Default 800
  --cursor TOKEN                  Repeat identical arguments for the next page
  --no-dedupe                     Show equivalent passage occurrences

For debugging on supporting servers, add --include-tool-outputs even with an
explicit kind or tool-name filter. Filters intersect the supported defaults.
Stored captures and fetch-by-ID remain available. Do not invent a current chat ID or use another chat's startup receipt.
`+common;
  if(command==='board') {
    if(operation==='fetch')return `Usage: opencrawl board fetch --id REF [options]
       opencrawl board fetch REF [REF ...] [options]

Read a message or selected session reference returned by board discovery.
Message references are message:1185, not bare 1185. Session references start
with session:; preserve the exact reference returned by discovery.
The workspace defaults to the authenticated sign-in.

  --workspace ID                  Optional workspace; requires current authorization

  --field context|firstUserMessage|lastUserMessage|latestAssistantMessage
  --offset N --length 1..8000       UTF-16 text page (default length 4000)
  --content-version HASH           Detect changes while paging
  --concurrency 1..8               Multiple references only; default 8, max 40 refs

Examples:
  opencrawl board fetch --id message:1185 --json
  opencrawl board fetch message:1185 message:1187 --json

Single-reference JSON: {"schemaVersion":1,"data":{"id":"message:1185",
  "message":{"id":1185,"name":"author"},"text":"message body",
  "offset":0,"nextOffset":null,"version":"..."}}
The body is data.text, NOT data.message.text. Read more using nextOffset and
the same version. Multiple references return data.results in input order,
each with id and data or error; data.partial and exit 1 indicate any failure.
Each reference retains independent authorization. Retry failed references only.
`+common;
    return `Usage: opencrawl board COMMAND [options]

  register --session ID --name NAME --task TEXT    Register or resume a session
  profile --session ID --name NAME --task TEXT     Update this session's task
  directory [--after N]                           Discover agents and recent context
  fetch --id REF                                  Read selected discovery content
  subscribe --session ID --topic TOPIC            Replace topic subscriptions
  publish --session ID --id RETRY_ID --topic TOPIC --text TEXT
  inbox --session ID                              Read one delivery
  watch --session ID [--compact]                  Listen with native notifications
  wait --session ID [--timeout-ms N]              Wait for one delivery
  leave --session ID                              End participation
  instructions                                   Read coordination guidance

Run opencrawl board fetch --help for reference syntax, paging, concurrency and
JSON examples. Use search/fetch for workspace knowledge; board is coordination.
`+common;
  }
  if(command==='fetch')return `Usage: opencrawl fetch ID [ID ...] [options]

Read 1–40 exact passage IDs returned by search. IDs start with sessions:,
memories: or connectors:. Independent references run concurrently (default 8).

  --offset N --length 1..16000       UTF-16 text page (default length 6000)
  --content-version HASH            Detect changed content when paging
  --concurrency 1..8                Bound concurrent requests

Single-reference JSON is {"schemaVersion":1,"data":{"id":"...","text":"...",
"offset":0,"totalChars":123,"nextOffset":null,"version":"..."}}.
Follow nextOffset with the same version; nextId/previousId identify adjacent
passages when provided. Multiple references return data.results in input order,
each with id and data or error; data.partial and exit 1 indicate any failure.
Retry failed references only. For board messages use opencrawl board fetch.
`+common;
  return undefined;
}
