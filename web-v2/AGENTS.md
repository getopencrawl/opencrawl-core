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
  wordmark. Workspace navigation stays grouped at the right; its active underline
  sits close below the label. Retain the content-aligned maximum width.
- Use the components exported from src/design/components.tsx. Never add a second
  native button, field, dialog or table implementation in a feature page. Add a
  shared primitive when an actual feature needs one. Native details/summary and
  semantic lists remain available for content.
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
- Async pages distinguish loading, empty, failed and current data. Abort reads on
  teardown, guard stale responses and give actionable failures. Controls preserve
  disabled, busy and error semantics. Client visibility never grants permission.
- Run npm run check before release. Architecture tests enforce these boundaries;
  never weaken them to accommodate a feature. Add a regression when a real
  behavior or invariant changes. Browser checks must prove history/back/forward,
  no document reload on internal links, desktop/mobile keyboard navigation and
  the approved onboarding appearance.

## Screen-by-screen visual restoration

The approved original Usage screen is the visual specification for the report,
including its nested source cards and horizontal header. Preserve its character;
TypeScript and shared components are implementation improvements, not permission
to replace approved visuals. AppShell owns the shared top bar on every route and one responsive navigation
tree. Usage is one page ordered Agent sessions, Data sources, Team. Show real
indexed document-type counts inside each source tile, separately from imported
records; never compare distinct corpora with relative-size bars. Restore and
review one screen before redesigning another.
Do not repeat the source breakdown as a large indexed-document total or an
"Imported N" summary. Keep the useful per-type counts and sync metadata.

Integrations preserves the original centered, catalog-ordered stack of connection
cards through the shared `oc-connection-*` patterns. Keep per-stream import counts
visible; use real progress only when it measures completed work against a known
total. Retain shared dialogs and the distinct recovery paths for sign-in, sync,
and permanent deletion.

Team administration uses the shared management-page and member-list patterns.
Keep names and emails together, roles explicit, pending invitations in the same
roster with a Pending state, and invitation controls in the member panel. Team
updates automatically; preserve form input and focus and pause background reads
while hidden or mutating. Do not add a normal-state Refresh button.
Team activity rankings remain on Usage. Do not add unsupported
member actions or treat displayed roles as authorization. Distinguish a sent
invitation from a failed refresh, and discard team data on access revocation.
