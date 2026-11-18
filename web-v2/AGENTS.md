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
  `/team` and hosted `/billing` redirects preserve query and hash. Agent setup
  remains a sidebar destination at `/agent-setup`. Settings uses the gear,
  Agent setup the terminal, and Message board the speech bubble; keep them distinct.
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
  The popover contains Settings, Docs and runtime account actions such as Sign out;
  omit the static email/role summary and show no empty popover without actions.
- Use the components exported from src/design/components.tsx. Never add a second
  native button, field, dialog or table implementation in a feature page. Add a
  shared primitive when an actual feature needs one. Native details/summary and
  semantic lists remain available for content.
- Every sidebar destination uses Page with one shared PageHeader. Keep the 32px
  desktop / 28px mobile title, 8px description gap and 32px header-to-body gap.
  Every workspace page uses the default full-width body, including Integrations,
  Agent setup and Settings with its Team and hosted Billing sections. Bound
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
- Use stale-while-revalidate for browser display reads by default. Keep the page frame and last authorized content visible during refresh. Reserve direct calls for writes, authorization, or operations with explicit cancellation or cursor semantics. Cold reads use accessible status text within the page. Use the shared
  scoped ConsoleDataProvider and data hooks for stale-while-revalidate reads;
  retain loaded data across navigation and clear it on scope/access changes. Abort reads on
  teardown, guard stale responses and give actionable failures. Controls preserve
  disabled, busy and error semantics. Client visibility never grants permission.
- Run npm run check before release. Architecture tests enforce these boundaries;
  never weaken them to accommodate a feature. Add a regression when a real
  behavior or invariant changes. Browser checks must prove history/back/forward,
  no document reload on internal links, desktop/mobile keyboard navigation and
  the approved onboarding appearance.

## Screen specifications

../DESIGN.md owns the per-screen specification for Usage, Integrations, Team,
Message board and Search playground: layout, copy rules, refresh and failure
behavior. Follow it rather than restating it here. Approved screens remain the
visual baseline; TypeScript and shared components are implementation
improvements, not permission to replace approved visuals, and changing a screen
requires its own explicit scope. Keep search-only styles in the shared design
system and preserve the existing public diagnostic exports.

Sessions and Memories are core-owned pages driven by one LibraryAdapter and the
core library API (see ../docs/sessions-and-memories.md). The server owns scope,
visibility and ownership: never hide or show owner controls as a permission
decision, and never filter private items in the client. List and viewer state
live in the URL so history and links work. Transcripts render server-normalized
entries as text; never render captured content as HTML. Deleting asks for
confirmation in the shared Dialog. Access failures clear loaded content.
