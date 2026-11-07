# OpenCrawl design system

Night: the getopencrawl.com look. A plain black canvas, near-black panels with hairline borders, Geist type,
and buttons in the OC mark's style. `web/tokens.css` owns colors, fonts,
spacing, radii, sizes and elevation; `web/frame.css` owns the page frame (glass header, brand lockup, content column); `web/controls.css` owns
buttons and focus. The existing hosted shell consumes these shared assets.

Primary actions use a plain lavender face (`--primary`) at rest, with no layers.
Only hover reveals coral and cobalt at the sides (`--logo-layers-wide`) and
brightens the face over 160ms. The layers disappear on pointer exit and press.
This is the shared default in `web/controls.css` for buttons and
links. Split controls put the layers around their outer edge, including when
either segment is hovered; their internal divider stays unchanged. Secondary actions use the
muted indigo `.secondary` treatment. Panels use `--surface`, `--line` and
`--radius-panel`.

Use Geist for UI/prose and Geist Mono for technical identifiers and copyable
commands. Fonts are self-hosted and retain `web/assets/Geist-OFL.txt`. Display
headings are 600 weight with tight tracking (`--tracking-display`); UI uses
14px, body 15px, labels 13px and metadata 12px. Controls use 6px corners,
surfaces 12px. Use 40px minimum desktop controls and 44px mobile/coarse-pointer
targets, visible keyboard focus and semantic HTML.

The product is dark only, like the landing page. Avoid local palette, font,
radius or shadow overrides; add tokens here instead. Add shared components when
an actual product feature needs them.


## Guided setup and workspace preview

The guided surface keeps the Night palette and type. `src/frontend-document.mjs`
provides `renderDocument`: a shared brand header, skip link and document assets.
`web/frontend.css` supplies its compact frame and 44px controls. Guided setup
uses the shared layered lavender primary actions and a brand header with the existing quiet
Sign out button at the top right. Use a full-width header with a centered 960px content span: 72px high
with `max(--pane-inset, (100% - 960px) / 2)` horizontal insets, reduced
to 60px high with 16px insets on mobile. Avoid nesting this within another
max-width header. The runtime supplies its POST logout URL; core
does not own hosted authentication. The full workspace
navigation appears only after setup. This frame coexists with
the existing hosted `frame.css`; it has not replaced the deployed shell.

`src/onboarding.mjs` keeps the active instruction, copy action and connection
signals together. CLI sign-in, MCP sign-in and the connection test appear as a
checklist immediately. Separate new-session recording and optional history-import
items are visible from the first screen. Recording appears above optional history. The connection test is indented
32px beneath MCP sign-in. First-recording verification and optional history are
indented by the same amount beneath recording, aligning each child status icon
with its parent label. Both
remain visible without extra explanatory subtext in the initial checklist. “Enable
session recording” expands to a copyable `opencrawl collect install` command,
which installs hooks and offers the optional history choice. The expanded row
has a separate child, “Waiting for first session recording,” that expands to
“Start a new chat to verify recording works.” Installing hooks alone does not
complete the recording receipt check. History expands to the interactive `opencrawl collect backfill` command. The
terminal offers Claude Code, Codex, both, or skip; the UI does not duplicate that
choice. The command omits JSON mode and the default production URL, preserving
an explicit deployment URL only for other deployments. Import
completion remains independent of new recording, regardless of execution order.
Copying briefly changes only the button label to “Copied” for 1.5 seconds. Its
adjacent control reveals the exact prompt instantly. The two button segments
use the shared primary hover feedback. Their divider uses an opaque mix
of the default face color to stay stable through hover and focus, with a visible
local keyboard outline. Manual instructions live inside the checklist: CLI
installation and login share one multiline copy bar under CLI sign-in, the
server URL and approval instruction sit under MCP sign-in, and hook installation
sits under recording.
There is no separate “Connect manually” section. These status rows use native
disclosures: their icons
and labels keep their normal appearance; hover brightens the label and chevron, with a
pointer cursor. Each expandable checklist label has a quiet 14px chevron beside it, with an 8px gap;
it points down when closed and flips up instantly when open. Expansion reveals `opencrawl login` or the MCP server URL.
The CLI command uses its existing device-code flow for both local and remote
terminals; the instructions tell users to open the printed URL in their browser.
Keyboard focus and Enter/Space use native summary behavior. Expanding a row never
completes a check. When an item first transitions to complete, its disclosure
closes. If focus was inside, it returns to the summary. A user can reopen it
afterward; unchanged polling does not close it.

Commands and MCP URLs use full-width copy bars with the existing copy icon at
the right edge, a pointer cursor, and immediate surface/border hover feedback.
Clicking copies the exact snippet and briefly replaces the icon with “Copied”
for 1.5 seconds, without shifting the layout. Short command tokens stay intact
when wrapping; long URLs can wrap within their bar. Checklist instructions use consistent
bars and aligned edges. Clipboard failure selects the text and explains how to
copy it with the keyboard or selection menu. Error instructions persist until
the next copy attempt or preview reset, while successful feedback clears after
1.5 seconds. The feedback column stays a fixed 48px wide in either state.

The full checklist stays on one screen throughout setup. Headings, descriptions,
and the copy action follow the next missing check; status receipts never
navigate or replace the checklist. After CLI sign-in,
MCP sign-in remains a human approval step. Once MCP connects, the agent-test
prompt is a fallback while the successful tool receipt is missing; an existing
receipt skips it. A successful test leads to “Start a new coding session,” which
asks the user to open a new session and provides only a small task to paste into
it. The task does not pretend to launch another session or run manual sync/flush.
An existing accepted recording skips the handoff. Once required checks pass,
the original setup description and copy action remain in place. A compact Next
button appears outside the panel, 24px below it and aligned to its right edge. Optional history
retains its real status and never blocks Next. Reloading setup retains the
completed checklist; navigation occurs only on the user’s click. Out-of-order MCP sign-in keeps
the user focused on CLI approval. All onboarding H1s omit terminal punctuation.

The recording screen has its own required “Waiting for first session recording”
check. On completion, “Session recording enabled” and “Import past sessions” appear as
separate outcomes. History is visible and manually accessible from the start,
and is explicitly optional. The guided setup prompt still prioritizes recording
before offering history. Before and after activation, history uses the same
copyable interactive backfill command and terminal source picker. During an
import, show progress without another import action. The agent setup prompt
still requires a dry-run and explicit confirmation before agent-driven uploads.
Copying never marks history imported. An observed history receipt supplies
“Imported”; an explicit skip supplies “Skipped.” History never participates in the
required recording gate. The setup prompt defers history and installs collection
with `--backfill skip` so an earlier history choice cannot interrupt activation.

The optional-history presentation expects an independent `history` status with
`state` and `observedAt`, plus a scoped adapter for saving skip preferences. The
current preview implements that contract only in its disposable fixture server;
live runtime adapters still need to supply it. Sources links back to setup for
later history import, without locking the workspace again.

The default onboarding shell uses the v1 Night panel tokens, with no query
parameter required. Legacy `?variant=panel` links render the same layout. Its content
aligns left within a centered panel. Signal rows share a 20px icon column and
a 12px text gutter. Rows are at least 44px high; 32px separates the copy action
from the checklist. Panel padding is 32px, reduced to 24px on narrow screens.
Preserve spinner behavior and the shared text edge in both disclosure states.
Expanded instructions and prompt content may scroll. The compact-height layout
applies through 800px, including iPad mini landscape. Troubleshooting lives in
the relevant checklist item; there is no separate help section.

A status error replaces the task with one retry action. Clipboard failure uses a
separate manual-copy screen; acknowledging a copy changes only the instruction.
Loading and step changes remain explicit, with announcements and managed focus.
This iteration is a local preview only; the hosted frontend remains unreleased.

`web/onboarding-state.js` requires three independent durable receipts with valid
`observedAt` timestamps: `cli` for CLI sign-in, `mcpTest` for a successful
`test_connection` call, and `session` for an accepted session. Copying a prompt,
elapsed time or generic `mcp` authentication never completes a check. Missing
receipts select the first unfinished step. All three keep the completed checklist visible and reveal a Next link to
Sources; runtime adapters must also gate workspace routes and APIs.

`src/workspace.mjs` and `web/workspace.*` provide Search and Usage screens.
Sources remains part of onboarding after agent setup; one connected source is
required before the workspace opens.
The current preview uses labelled sample results, simulated connections and
local counters. Adapters must supply authorized real data and appropriate copy
before these screens serve production traffic.

The isolated fixture server and private tailnet preview are documented in
`docs/frontend-preview.md`. No hosted shell release or production integration is
claimed. Hosted adoption still requires wiring `onConnectionTest:
onboarding.mcpTest`, preserving `mcpTest` in the shell's onboarding response
merger, adopting `renderDocument` and its assets/navigation, and enforcing the
three-receipt gate before Sources and the connected-source gate on workspace
routes and APIs. The current core session
receipt records any accepted batch; hosted adoption must distinguish fresh
recording evidence from historical imports before claiming that the gate proves
new-session capture. Preview fixtures do not establish that production property. Keep the existing generic `mcp`
receipt separate from successful tool verification.

## Source connection step

`src/onboarding-shell.mjs` owns the shared panel placement and outside-panel
navigation for agent setup and Sources. Both use the onboarding header from
`renderDocument`: the same centered 960px span, brand mark and Sign out control,
with no workspace navigation. The Sources step uses the 640px Night panel,
left-aligned heading and description, and the same right-aligned Next button.
Back returns to agent setup without clearing its receipts.

`src/onboarding-sources.mjs` provides only the heading, a short requirement,
connector search and a grid of full-tile Connect buttons. Desktop shows two columns and three rows of 64px tiles; narrow
screens use one column of 56px tiles. Each tile has a fixed 32px logo column,
a left-aligned name in the middle, and a 20px plus at the right. Hover highlights the border and plus icon. Connected tiles retain
their geometry and replace the plus with the existing green circled check.
The whole tile supports click, tap and keyboard activation; there is no nested
button. Connection errors appear beneath their tile; clicking the tile retries. All six connectors fit without an internal scrolling list.

All icons share a 128-unit rounded-square canvas with a 28-unit corner radius.
Google Drive and Slack keep their original marks on white backgrounds; Granola,
Notion and GitHub keep their existing assets. Circleback's original artwork is
clipped to the same corner geometry.
There are no category sections, duplicate instructions, monograms or workspace
sections. Search filters names in place when the catalog has at least 15
connectors. It is hidden initially and below that threshold, clears stale
filters when hidden, and leaves no extra layout gap. Visibility uses the full
catalog count, so filtering does not hide the field. A confirmed connection
updates its tile status without moving the logo or name. Next appears only
after the server reports at least one connected source, regardless of the
current search filter. Clicking never advances automatically.

Loading, no matches, catalog failure and a failed connection retain the same
content area. The tile keeps its identity and keyboard focus while connecting;
a failure offers the same Connect action for retry. Status is announced without
changing the heading. The private preview mirrors the six active hosted connectors at main
`7c8261e9d`: Google Drive, Slack, Granola, Circleback, Notion and GitHub. Gmail
is disabled. Filtering preserves the grid column widths when search is available. Connections are simulated; real OAuth, live connector discovery, indexing
progress and hosted source receipts remain adapter work. Preview routes and
workspace APIs enforce the agent receipts plus at least one source.


## Optional teammate invitations

`src/onboarding-invite.mjs` is step three at `/onboarding/invite`, after Sources.
It reuses the same 640px panel, header, left-aligned content and outside-panel
Back/forward navigation. Shared Back/Skip styling lives in `onboarding.css`.
The shared shell accepts the forward label, visibility and primary treatment
so this step does not duplicate the frame.

Keep this step to simple invitation rows followed by one email field and an
Invite button on the same bottom row, with a clearly visible Skip for now link.
Validate one address per submission, trim and deduplicate it, and return focus
to the cleared field so another teammate can be added with Enter. Errors stay
beside the field; a network failure preserves the address. Accepted invitations
appear above the entry row using the existing circled check, without redundant
status labels or a preview notice beneath the entry field.
The forward action becomes Open workspace after an accepted invitation, with
no automatic navigation. Back returns to Sources; skipping opens the workspace
without creating an invitation requirement.

The private preview stores invitation records only in its browser fixture.
The hosted adapter owns organization membership, inviter authorization, role
policy and actual email delivery; core UI does not import WorkOS or grant
workspace access. Preview invite routes require the existing agent and source
gates, but inviting anyone is never a workspace gate.
