# OpenCrawl web application

Read ../ARCHITECTURE.md and ../DESIGN.md before changing product behavior or UI.
This is the TypeScript React product package. Hosting providers supply trusted
DTOs and runtime adapters; WorkOS, billing and managed connector code stay outside.

- AppShell is the only workspace shell and navigation implementation. Its route
  registry drives navigation and routing together. Use Link, Navigate and router
  hooks for internal paths. Full navigation is reserved for authentication and
  external authorization boundaries.
- Brand is the only mark/wordmark component. Use the static mark and lowercase
  opencrawl wordmark; never restore animated logo assets or hide the desktop
  wordmark. Workspace navigation lives in the persistent left sidebar with a lavender
  selected row. Match the supplied account-footer reference: a full-width docked
  row below a divider, workspace icon, person above workspace, and one trailing
  account-menu chevron. Do not duplicate workspace context beneath Brand or make
  the footer a floating card. Retain the content-aligned maximum width.
- Use the components exported from src/design/components.tsx. Never add a second
  native button, field, dialog or table implementation in a feature page. Add a
  shared primitive when an actual feature needs one. Native details/summary and
  semantic lists remain available for content.
- Every sidebar destination uses Page with one shared PageHeader. Keep the 32px
  desktop / 28px mobile title, 8px description gap and 32px header-to-body gap.
  Every sidebar page uses the default full-width body, including Integrations,
  Team, Billing and Settings. Bound individual form rows with oc-form-measure
  and prose with its shared measure; never narrow or recenter the whole page,
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
tree. Usage is one page ordered Agent savings, Agent sessions, Data sources, Team, with no summary sentence above them. Agent savings is four metric cards (money saved at the list price of the model the workspace mostly uses, turns saved, conflicts avoided, searches used), each with its percentage where one applies, each with a question-mark hover saying in two sentences how it is calculated, rendered only from a measured value report of real OpenCrawl uses (searches the agent used and fixes reused from the board) in work captured live since install; never a projection of what agents could have saved, never estimated in the UI, with no explanatory note outside the hovers and no comparison to OpenCrawl's own price. Show real
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
unframed provider icons. Search and state filters support a growing catalog.
Shared dialogs retain setup, sign-in recovery, sync retries and confirmed deletion.

Team administration uses the shared management-page and member-list patterns.
Keep names and emails together, roles explicit, pending invitations in the same
roster with a Pending state, and invitation controls in the member panel. Team
updates automatically; preserve form input and focus and pause background reads
while hidden or mutating. Do not add a normal-state Refresh button.
Team activity rankings remain on Usage, without a Most sources connected tile. Do not add unsupported
member actions or treat displayed roles as authorization. Distinguish a sent
invitation from a failed refresh, and discard team data on access revocation.

Diagnostics board views preserve the original forum structure through shared
ForumPanel/ForumPost and Table: shaded title/count bands, a compact topic list,
and an author rail beside full message text. Do not invent avatars or status
icons. Label loaded message counts as “Showing N messages”; topic summary counts
come from the adapter. Refresh automatically while visible, with one read at a
time. Bridge new pages to the displayed newest post before prepending them;
never merge a new head directly into stale paginated history. Validate overlapping
page boundaries. Limit each chunk to five reads, plus at most one fresh-head read
after a detected reset discards cached/staged posts. Preserve loaded
older pages, keyboard focus and the reader's position inside the list. At the
start of a list, let new posts appear naturally. Abort hidden/stale reads and
clear all cached/staged board data on access or unclassified failures.

Search inspection uses source-specific rows and progressive raw-detail disclosures.
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
