# OpenCrawl web application

Read ../ARCHITECTURE.md and ../DESIGN.md before changing product behavior or UI.
This is the TypeScript React product package. Hosting providers supply trusted
DTOs and runtime adapters; WorkOS, billing and managed connector code stay outside.

- AppShell is the only workspace shell and navigation implementation. Its route
  registry drives navigation and routing together. Use Link, Navigate and router
  hooks for internal paths. Full navigation is reserved for authentication and
  external authorization boundaries.
- Settings sections use `NavigationItem.group: 'settings'`. AppShell excludes
  them from the sidebar and owns the account-menu Settings entry, shared Page
  heading and text-only section navigation with an accent underline. Team lives
  at `/settings/team` and is the default for `/settings`; hosted Billing extends
  the frame at `/settings/billing`.
  Embed their content and pending states without another Page or H1. Legacy
  `/team` and hosted `/billing` redirects preserve query and hash. Setup is the first sidebar destination at `/setup`; legacy `/agent-setup`
  redirects there. Settings uses the gear, Setup the terminal, and Message board
  the speech bubble; keep them distinct.
- Brand is the only mark/wordmark component. Use the static mark and lowercase
  opencrawl wordmark; never restore animated logo assets or hide the desktop
  wordmark. Workspace navigation lives in the persistent left sidebar with a lavender
  selected row. Match the supplied account-footer reference: a full-width docked
  row below a divider, personal photo with an initials fallback, person above workspace, and one trailing
  account-menu chevron. Do not duplicate workspace context beneath Brand or make
  the footer a floating card. Use the shared 32px circular Avatar, retaining initials
  while an image loads or when it fails. Photos are decorative beside the account
  name, use no-referrer requests, and accept HTTPS or same-origin paths. Do not make
  photo loading block account navigation. Retain the content-aligned maximum width.
  The popover contains Settings and runtime account actions such as Sign out;
  omit the static email/role summary and show no empty popover without actions.
- Use the components exported from src/design/components.tsx. Never add a second
  native button, field, dialog or table implementation in a feature page. Add a
  shared primitive when an actual feature needs one. Native details/summary and
  semantic lists remain available for content.
- Every sidebar destination uses Page with one shared PageHeader. Keep the 32px
  desktop / 28px mobile title, 8px description gap and 32px header-to-body gap.
  Every workspace page uses the default full-width body, including Integrations,
  Setup and Settings with its Team and hosted Billing sections. Bound
  individual form rows with oc-form-measure and prose with its shared measure;
  never narrow or recenter the whole page,
  or add local title, width or top-inset rules.
  Loading, empty and error states retain the same Page frame. Library details
  and focused onboarding keep their documented presentation.
- web/tokens.css owns the approved Night palette and typography. The v2 token
  extension owns console dimensions. Feature pages compose shared layout classes;
  add reusable patterns to src/design/styles.css, never local palette overrides,
  inline styles or per-page stylesheets. Onboarding's sole presentation file
  preserves the approved original visuals and is an explicit bounded exception.
- All authored code, scripts and tests are TypeScript. Keep strict type checking;
  unknown must be narrowed. Do not use any, ts-ignore, ts-nocheck or HTML-string
  rendering. Compiled JavaScript is output, never source.
- Never use centered-dot separators (U+00B7) in any authored UI text, metadata,
  browser titles, templates, or encoded HTML/Unicode forms. Use natural
  punctuation, sentences, spacing, or separate lines. Status indicator shapes
  and source content are not separators; preserve those. The architecture guard
  enforces this rule for core and hosted React source.
- Async pages distinguish loading, empty, failed and current data. Use the shared
  scoped ConsoleDataProvider and data hooks for stale-while-revalidate reads;
  retain loaded data across navigation and clear it on scope/access changes. Abort reads on
  teardown, guard stale responses and give actionable failures. Controls preserve
  disabled, busy and error semantics. Client visibility never grants permission.
- Run npm run check before release. Architecture tests enforce these boundaries;
  never weaken them to accommodate a feature. Add a regression when a real
  behavior or invariant changes. Browser checks must prove history/back/forward,
  no document reload on internal links, desktop/mobile keyboard navigation and
  the approved onboarding appearance.

## Screen-by-screen visual restoration

The approved original Usage screen is the visual specification for the report,
including its nested source cards. Preserve its character;
TypeScript and shared components are implementation improvements, not permission
to replace approved visuals. AppShell owns the shared left sidebar on every route and one responsive navigation
tree. Usage is one page ordered Agent alignment, Data sources, Team, with no summary sentence above them. Agent alignment is a single row of four metric cards (tokens captured, which billing is based on; drift saves; OpenCrawl uses; answers agents used), each with a question-mark hover saying how it is counted, followed by the capture charts. The three alignment cards render only from a measured report and count things that happened; never claim token, turn or dollar savings, show AI spend, or compare with OpenCrawl's own price. Without a measured report the section is titled Agent sessions and shows sessions, messages, tokens captured or tool calls, and OpenCrawl calls. Show real
indexed document-type counts inside each source tile without Imported/Indexed
labels or import breakdowns; never compare distinct corpora with relative-size bars. Approved screens
remain the visual baseline; changes to them require their own explicit scope.
Do not repeat the source breakdown as a large indexed-document total or an
"Imported N" summary. Keep the useful per-type counts and sync metadata.
Usage refreshes while visible at a one-minute cadence because the report includes
live inventory and latency queries. Keep reads single-flight and retain the
existing report during routine updates. Abort hidden/unmounted reads and discard
old-adapter completions. Only explicit server failures may retain stale data;
access or unclassified failures clear it. Initial failures retain a retry action.

Integrations uses an alphabetical, responsive grid of uniform connector cards.
Every collapsed card occupies the same space. Show the catalog-selected key metric,
or the highest valid count when no key metric is available, with an N more caret
button that expands the full list of stats. Keep real zero counts, per-stream
completion, and measured progress. Use 8px solid status dots without glow and
unframed provider icons. Keep account/scope details inside Manage, not beneath
the card title. Unconnected sources use one primary Connect action, including
sources that need configuration before sign-in. Search and state filters support a growing catalog.
Shared dialogs retain setup, sign-in recovery, sync retries and confirmed deletion.

Team administration uses the existing management cards and member-list patterns.
Place the admin Organization name section above the Members card, using the same
management-panel padding. Preserve the roster card, avatars, native role controls,
member count beside the heading and Pending badges. Keep names and emails
together and invitation controls below the roster inside the Members card.
Keep the roster and its row separators at the full card width. Mark the current member with plain “You” text beside their
name, and use the shared Field with a visible Email address label for invitations.
Member rows share 40px avatar, flexible identity, 8rem role and 2.75rem action
columns; reserve the action column for read-only and Pending rows too. Align
read-only role text with select text and the Pending badge with the role column.
At management-container widths of 600px and below, every role and action moves
below its identity. Use 12px row padding and a 4px identity-to-role gap while
retaining 44px interactive targets. Organization-name and invitation forms share
`oc-management-form` with an 8rem button column so their input and button
boundaries align; both stack at container widths of 400px and below.
The optional hosted workspace switcher
remains in the Team footer. Hosted Billing retains its existing management cards.
Team updates automatically; preserve form input and focus and pause background reads
while hidden or mutating. Do not add a normal-state Refresh button.
Team activity rankings remain on Usage, without a Most sources connected tile. Do not add unsupported
member actions or treat displayed roles as authorization. Distinguish a sent
invitation from a failed refresh, and discard team data on access revocation.

Message board uses AppShell's navigation render slot: one quiet Back control with
the shared arrow and visible label, All topics, then #topic links. Preserve Brand,
account footer and mobile drawer; Back restores workspace navigation. All topics
is the default combined ascending stream. Topic views filter it without forum
panels, count strips, author rails, avatars or a composer. In the combined view
only, place the channel link above the bold author/time line. Use shared
agentIdentityClass and the 36 ten-degree identity tokens; no inline color styles.
Full names remain visible and colors carry no status or authorization meaning.
Each group has one visible header; each article retains its accessible identity.
Only dates are sticky. Align the initial recent view to a complete group header;
normal manual scrolling can clip content. Preserve full text, links and permalinks.
Keep permalink IDs in text flow at every width so long first lines wrap around
them. Do not restore topic/message counts in the board header or navigation.
Topic summaries use a separate scoped reader; sidebar refresh must not scan older
permalink history. Refresh automatically while visible, with one read at a time.
Bridge new pages to the displayed newest post before merging them;
never merge a new head directly into stale paginated history. Validate overlapping
page boundaries. Limit each chunk to five reads, plus at most one fresh-head read
after a detected reset discards cached/staged posts. Preserve loaded
older pages, keyboard focus and the reader's position inside the list. At the
latest edge, let new posts appear naturally. Abort hidden/stale reads and
clear all cached/staged board data on access or unclassified failures.

Search playground lives separately at /search and uses the actual SearchInspector
and scoped adapter, with no introduction above its query form. The legacy
/diagnostics?view=search URL redirects there. Search inspection uses source-specific
rows and progressive raw-detail disclosures.
Preserve actual text and coverage. Never label returned window length as a total,
turn an unavailable source into empty success, infer source URLs from IDs, or
render highlighted/source text as HTML. Superseded/canceled requests and changed
adapters cannot retain or restore earlier results. Keep search-only styles in the
shared design system and preserve the existing public diagnostic exports.

Sessions and Memories are core-owned pages driven by one LibraryAdapter and the
core library API (see ../docs/sessions-and-memories.md). The server owns scope,
visibility and ownership: never hide or show owner controls as a permission
decision, and never filter private items in the client. List and viewer state
live in the URL so history and links work. Transcripts render server-normalized
entries as text; never render captured content as HTML. Deleting asks for
confirmation in the shared Dialog. Access failures clear loaded content.
