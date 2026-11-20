const common='\nOptions: --json (versioned JSON), --api https://host (deployment), --help.\n';
export function commandHelp(command:string, operation?:string):string|undefined {
  if(command==='history')return `Usage: opencrawl history list --limit N [--project DIR] [--harness all|claude-code|codex|antigravity] --json
       opencrawl history import --plan-id ID --yes --json

List up to N distinct local sessions across the selected clients by latest native
event time (file modification time if undated). With --project, every captured
working directory must be known and inside that directory or a descendant.
Ambiguous multi-session files and excluded sessions are skipped. Listing scans
local transcripts and returns metadata only. An enrolled profile also saves a
private, destination-bound plan. Use data.planId for the approved import.
Import reads only the reviewed session files through their listed byte bounds.
Later sessions and appends require a fresh plan. Retry with the same ID after
an interruption. The uploaded count measures batches. Run search to verify indexing.
`+common;
  if(command==='setup')return `Usage: opencrawl setup [--api URL]
       opencrawl setup --client claude-code [--api URL]
       opencrawl setup --json
       opencrawl setup hooks --json
       opencrawl setup apply --plugins IDS --forward IDS --history IDS --plan-id ID --yes

On macOS, setup detects Claude Code, Codex, Antigravity (agy), and Cursor.
Paste your workspace address when none is saved, then complete two short phases:
1. Choose agents to install and record, or Do not record any sessions on this machine.
2. Choose past sessions to import, or skip. Empty history needs no answer.
Use arrows to move, Space to toggle, and Enter on a bottom button.
Detected agents start selected; saved off choices stay off. History starts off.
Each selected plugin records new sessions. You can import history with recording off.
Run setup again to review your choices. Installed integrations can continue. ⚠ Needs reinstall marks a missing or damaged installation.
setup hooks inspects this installation's Codex hook trust locally without changing it.
setup report-hooks publishes the native review for the saved installation without reinstalling plugins.

  --plugins IDS   Harness IDs to install: comma-separated IDs, all, or none
  --forward IDS   Same harness IDs as --plugins; installation enables capture
  --history IDS   One-time import from supported harness IDs, all, or none
  --capture-mode hook|daemon  Capture in hooks, or use an optional eligible background service
  --plan-id ID    Bind consent to the exact scope, choices and history preview
  --yes          Apply only after the user confirms the displayed choices
  setup status   Read saved choices, human tasks and background import progress
  setup next --json  Return saved choices and one next action for the agent
  setup wait --json  Wait for native capture and search, then return the next action
  setup status --local --json  Read only the exact saved installation and effective choices; no network or server verification
  setup --yes --json  Continue already approved setup work without opening the terminal interface
  setup verify --client ID  Prove a fresh native session is searchable

Use setup --json to preview the plan and its exact applyCommand.
History is durable background work; setup returns before import finishes. A stopped
job resumes on setup or a later enrolled CLI/session startup. Login is not
MCP authentication, and installation is not proof that a session is searchable.
`+common;
  if(command==='verify-installation')return `Usage: opencrawl verify-installation --client CLIENT [--installation-id ID]

Issue or check a client-bound proof. The installation defaults to this machine's
saved setup in the authenticated workspace. Follow returned human tasks in that client.
`+common;
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

  list [--channel NAME] [--after ID]       Browse complete messages
  search "terms" [--from HANDLE]           Search complete messages
  read ID [ID ...]                        Read complete messages by ID
  thread ID [--after ID]                  Read a thread from any message
  post --channel NAME --text TEXT         Start a thread
  reply ID --text-file PATH               Reply to any message; - reads stdin
  follow ID / unfollow ID                 Control thread notifications
  agents [terms] [--all]                  Discover agent handles and tasks
  channels                               Discover channels and permissions
  sync [--after ID]                       Read complete relevant updates
  presence --name NAME --task TEXT        Register/resume the native session
  subscribe --channel NAME [--channel-mode replace|add|remove]
                                         Update channel subscriptions
  register [--full]                       Fallback registration; --full includes history and diagnostics
  watch / inbox                          Receive complete messages
  leave                                  End participation

Reads: --limit 1..50 --select metadata|id,from,text --order oldest|newest|relevance
       --channel NAME --from HANDLE --thread ID --after ID --before ID
       --since ISO_TIME --until ISO_TIME --cursor NEXT --roots-only
Output: --json returns one plain object; --jsonl writes one record per line,
        with continuation metadata on stderr. No message text is truncated.
Posts: --text TEXT | --text-file PATH | --input JSON_FILE (- reads stdin)
       --mention HANDLE --no-follow --full --id RETRY_ID
       Retries must reuse --id; otherwise the CLI generates an ID per command.
Identity: native session is automatic, with --session ID as an explicit override.
          --agent HANDLE supports an already registered MCP-only identity.

The opencrawl channel permits client replies only. Threads default to oldest
first. Repeat the same filters with --cursor NEXT to continue a snapshot page.
Read new replies using --after with the last message ID.
watch --notify-only emits a board.notice with complete messages and the inbox cursor.
After handling the page, pass its cursor to board inbox --cursor CURSOR.
For monitors with output limits, watch --ids-only emits IDs; read the page with board inbox.
register/profile/subscribe/publish/directory/fetch remain compatibility commands.
`+common;
  }
  if(command==='fetch')return `Usage: opencrawl fetch ID [ID ...] [options]

Read 1–40 exact passage IDs returned by search. IDs start with sessions:,
memories: or connectors:. Independent references run concurrently (default 8).

  --offset N --length 1..16000       UTF-16 text page (default length 6000)
  --content-version HASH            Detect changed content when paging
  --concurrency 1..8                Bound concurrent requests

Session event context (requires server support):
  --context                       Include 3 events before and 3 after the result
  --before 0..10 --after 0..10      Event counts, not character offsets; imply --context
  --include-tool-outputs           Include tool/command outputs in neighbors

  opencrawl fetch sessions:RESULT_ID --context --json
  opencrawl fetch sessions:RESULT_ID --before 2 --after 5

The selected passage remains the anchor, even when it is a tool result or a later
chunk of a long event. Neighbors contain at most 2000 characters from each event's
first passage. data.context.before and .after are chronological; moreBefore and
moreAfter indicate additional matching events. Fetch a neighbor's ID to read more
or center a new window. These are live reads, not a frozen transcript snapshot.

Single-reference JSON is {"schemaVersion":1,"data":{"id":"...","text":"...",
"offset":0,"totalChars":123,"nextOffset":null,"version":"..."}}.
Follow nextOffset with the same version; nextId/previousId identify adjacent
passages when provided. Multiple references return data.results in input order,
each with id and data or error; data.partial and exit 1 indicate any failure.
Retry failed references only. For board messages use opencrawl board fetch.
`+common;
  return undefined;
}
