---
name: OpenCrawl Night
description: A shared dark operations console with Geist type and the OpenCrawl mark's periwinkle actions.
colors:
  bg: "#000"
  surface: "#0a090c"
  surface-subtle: "#131118"
  surface-raised: "#17151d"
  text: "#f7f5f6"
  strong: "#fff"
  muted: "#b9b4c0"
  quiet: "#8a8492"
  line: "#24212b"
  line-strong: "#353140"
  control-line: "#3d3949"
  brand-face: "#7d82ff"
  brand-face-hover: "#959aff"
  brand-coral: "#ff6268"
  brand-cobalt: "#164bff"
  brand-ink: "#0c0d2a"
  accent: "#a3a6ff"
  accent-hover: "#c5c7ff"
  secondary: "color-mix(in srgb, #7d82ff 22%, #050510)"
  secondary-hover: "color-mix(in srgb, #7d82ff 32%, #050510)"
  secondary-line: "color-mix(in srgb, #7d82ff 50%, #000)"
  on-secondary: "#e4e5ff"
  wash: "color-mix(in srgb, #7d82ff 12%, transparent)"
  selection: "color-mix(in srgb, #7d82ff 40%, transparent)"
  success: "#8fe0a8"
  success-wash: "#10261a"
  pending: "#f0c47e"
  pending-wash: "#2c2212"
  danger: "#ff8a95"
  danger-strong: "#ff6268"
  danger-wash: "#2d1217"
  backdrop: "rgb(0 0 0 / .72)"
typography:
  display:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "2.5rem"
    fontWeight: 600
    lineHeight: 1.12
    letterSpacing: "-.04em"
  console-heading:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-.025em"
  console-heading-compact:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-.025em"
  heading:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-.025em"
  title:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: ".9375rem"
    lineHeight: 1.5
  ui:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: ".875rem"
    lineHeight: 1.5
  control:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: ".875rem"
    fontWeight: 500
    lineHeight: 1.5
  label:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: ".8125rem"
    fontWeight: 500
    lineHeight: 1.5
  metadata:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: ".75rem"
    lineHeight: 1.5
  mono:
    fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: ".8125rem"
  metric:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.5rem"
    fontWeight: 500
    lineHeight: 1.5
rounded:
  badge: "4px"
  control: "6px"
  panel: "12px"
spacing:
  '1': "4px"
  '2': "8px"
  '3': "12px"
  '4': "16px"
  '5': "20px"
  '6': "24px"
  '8': "32px"
  '10': "40px"
  '12': "48px"
  '16': "64px"
components:
  button-primary:
    backgroundColor: "{colors.brand-face}"
    textColor: "{colors.brand-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.brand-face-hover}"
    textColor: "{colors.brand-ink}"
  button-secondary:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-quiet:
    textColor: "{colors.muted}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-plain:
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-danger:
    backgroundColor: "{colors.danger-wash}"
    textColor: "{colors.danger}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  navigation-item:
    textColor: "{colors.muted}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  navigation-item-active-mobile:
    backgroundColor: "{colors.wash}"
    textColor: "{colors.accent}"
  badge:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.muted}"
    rounded: "{rounded.badge}"
    padding: "4px 8px"
  inset:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "16px"
  dialog:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "24px"
    width: "min(520px, calc(100vw - 32px))"
  workspace-sidebar:
    backgroundColor: "{colors.surface}"
    padding: "16px 8px 0"
    width: "256px"
---

# Design System: OpenCrawl Night

## Overview

**Creative North Star: "Night"**

Night is the getopencrawl.com identity: a plain black canvas, near-black surfaces
with hairline boundaries, Geist type, and periwinkle actions drawn from the
OpenCrawl mark. The console applies that identity to compact, readable operational
work. Hierarchy comes from type, spacing, rows and sections; color identifies
interaction and meaningful status.

Core owns the shared visual system for hosted and single-tenant deployments.
`web/tokens.css` remains the canonical palette, fonts, spacing, radii and elevation
source. `web-v2/src/design/tokens.css` extends it with console dimensions and focus
constants; `web-v2/src/design/styles.css` owns the React layout and component
presentation. The frontmatter records their approved values; update the owning
CSS and this document together. Color aliases are resolved here without changing
the source color format. The sidecar carries motion, depth and component previews.

The shared `web/frame.css` and `web/controls.css` style hosted authentication,
organization selection, provider handoffs and cloud-capture setup. React onboarding
preserves its approved presentation in `web-v2/src/onboarding/onboarding.css`.
Use the existing self-hosted fonts, OC marks, provider logos and shared SVG icons.
The font license remains at `web/assets/Geist-OFL.txt`.

**Key Characteristics:**

- Dark-only Night palette and inherited brand assets.
- One React workspace shell with a persistent left sidebar on every workspace route.
- Quiet default controls, visible keyboard focus and explicit operational states.
- A separate focused onboarding composition within the same design system.

## Colors

The palette places a restrained periwinkle accent against black and near-black
neutrals. The frontmatter preserves the current CSS values, including mixed colors.

### Primary

`brand-face` is the plain lavender/periwinkle primary action face; `brand-ink`
provides its dark text. `brand-face-hover` brightens the face. `accent` and
`accent-hover` serve links, active navigation and focus. Coral and cobalt belong
to the existing OC mark and the primary button's narrow hover layers.

### Neutral

`bg` is the canvas. `surface` supports the navigation drawer, fields and onboarding panel;
`surface-subtle` separates insets, quiet hover states and secondary controls;
`surface-raised` supports dialogs and neutral badges. `strong` is heading text,
`text` is primary content, `muted` is supporting copy and `quiet` is metadata.
`line` divides sections; `line-strong` and `control-line` strengthen interactive
boundaries. Selection and active navigation use the existing periwinkle washes.

### Status

Success, pending and danger each pair a text color with a dark wash. Status badges
and notices always carry a readable label; color alone does not explain state.
Danger colors identify destructive actions and actionable errors. The legacy
muted-indigo secondary tokens remain available to the earlier shared controls;
React console secondary buttons use the neutral surface treatment documented below.

**The Shared Palette Rule.** Feature pages use the canonical Night tokens; a new
reusable visual value belongs in the core design system, never a page-local palette.

## Typography

Geist supplies headings, UI and prose; Geist Mono supplies identifiers, commands
and technical content. Keep the self-hosted font assets and their fallbacks.

Every sidebar destination uses one 32px, 600-weight H1 with 1.25 line height and
-.025em tracking (`console-heading`), reducing to 28px (`console-heading-compact`)
at 800px and below. Section headings use `heading`; smaller content headings use `title`.
The interface uses `ui`, descriptions use `body`, labels use `label`, and metadata
uses `metadata`. Technical text uses `mono`. Metrics and tables use tabular numerals;
metric values use the `metric` role. Prose is bounded to 75 characters where possible.

The earlier large display role remains available to its established surfaces.
Onboarding retains its existing heading scale and responsive adjustments in its
bounded presentation stylesheet; do not restyle it with the console page heading.

## Layout

`AppShell` is the only workspace shell. One route registry drives the left sidebar
and page routing through the shared router. The hosted routes are Usage, Sessions,
Memories, Integrations, Diagnostics, Team and Billing. Deployment adapters supply only their
supported routes; the shared shell does not imply hosted capabilities in the
single-tenant adapter.

The desktop sidebar is 256px wide and spans the viewport. Its static mark and
lowercase `opencrawl` wordmark come from Brand. The account footer is a full-width bottom row separated by a rule. It follows the
supplied reference: rounded-square workspace icon, person name above workspace,
and one trailing chevron for the whole account menu. Workspace and
management links form separate groups. Links have padded 44px targets and the
current page uses a lavender wash. The sidebar scrolls on short viewports.
The brand, navigation and account rows share a 32px leading column,
12px gap and aligned text edge. Rows use 8px horizontal insets inside the 8px sidebar gutter. The footer
uses 16px insets, preserving the same icon and label alignment. Navigation targets are 44px tall with 4px between rows; distinct
groups are separated by 12px of space, without a navigation divider. Keep the mark and wordmark optically aligned, and dock the identity row to the sidebar edges rather than floating it as a card.

Content is centered at 1200px within the remaining area, with 32px side insets,
48px top padding and 64px bottom padding. At 800px and below, the same navigation
tree becomes a focus-managed drawer bounded by 300px and the viewport minus 48px.
The mobile header retains Brand and its navigation control. Background content
becomes inert while the drawer is open; Escape, the backdrop and selecting a
page dismiss it. Content padding becomes 32px, 16px and 40px. There is no alternate
page-specific sidebar or navigation implementation.

Compose shared stacks, rows, action groups, split rows, two-column form grids,
metric lists and data rows. Forms collapse to one column at the mobile breakpoint.
Source rows and search forms stack at 600px. Tables retain their columns inside
a horizontal scroll region, with a scroll hint when they overflow. Section
boundaries and vertical rhythm organize content without wrapping every group in
a card. Page headers reserve a consistent description and action area.

### Workspace page contract

Use `Page` for every sidebar destination. `AppShell` owns the centered 1200px
content frame, 32px horizontal insets, 48px top inset and 64px bottom inset.
At 800px and below these insets become 16px horizontally, 32px above and 40px below.
The workspace document reserves its scrollbar gutter so short and long pages do
not shift; focused onboarding retains its original geometry.
Feature wrappers add no width, centering, top padding or page-title typography.

`Page` owns one `PageHeader` followed by its body. Every H1 starts on the same
left edge and top baseline. Descriptions use 15px body text, 1.5 line height,
muted text, a 75ch maximum and an 8px gap below the title. The header ends 32px
before the body. Let descriptions wrap naturally; do not force equal heights
or add empty description placeholders. Page-level actions belong in the header,
aligned at the top on desktop, wrapping below when space runs out and occupying
a separate row at 600px and below. Contextual actions stay with their section.
Use H2 for sections and H3 within them; use the shared 24px section padding and
48px report-section separation. Tabs and filters start the body, before results.

All sidebar destinations use the same full-width page grid, bounded to 1200px.
This includes Usage, Sessions, Memories, Integrations, Diagnostics, Team, Billing
and the self-hosted Settings page. The page header, section frames, tables and
lists share both edges. A route change must not create a narrower content column.

Readable measure belongs inside the grid: prose stays within 75ch, and individual
form rows use `oc-form-measure`, bounded to 640px and the space available. Keep
form labels, fields and submit actions together. Source cards, member rosters and
billing sections span the page; their inputs do not need to stretch with them.
Tables retain their own horizontal overflow region. Use `bodyClassName` for
existing body patterns and the default Page body for every sidebar destination:

`<Page title="Team" description="People and access for your workspace."><form className="oc-form-measure">…</form></Page>`

The legacy `bodyWidth="narrow"` prop remains compatible for earlier consumers,
but feature-page architecture checks reject it. New sidebar pages use one grid.

Loading, empty, failed and current states retain this same frame. Keep the page
heading focus target for SPA navigation and exactly one H1 per destination.
Library detail views may use compact document titles beneath their back link;
focused onboarding retains its approved independent presentation. The legacy
`PageHeader` report prop is accepted for compatibility but no longer changes
its appearance. Raw feature-page H1s are rejected by the architecture guard;
browser regressions measure every sidebar destination across the responsive range.

Guided onboarding stays outside `AppShell`, inside the same router. `FocusedFrame`
provides the bounded header and `OnboardingShell` provides the centered flow.
Its boxed panel is 640px wide with left-aligned content, a 960px bounded header,
and back/next navigation outside the panel. Preserve the existing mobile and
short-viewport rules in the onboarding stylesheet.

**The One Shell Rule.** Pages own their content; core owns workspace navigation,
responsive chrome and shared layout. Internal links use the router and preserve
history without document reloads. Full navigation is for external authorization,
authentication and deployment boundaries.

## Elevation & Depth

Tonal surfaces and hairline borders provide most depth. The existing paper shadow
adds a restrained inset highlight to the onboarding panel. The floating and dialog
shadows are inherited tokens for elevated surfaces; the React dialog uses the
dialog shadow with the shared dark backdrop. Their exact values are recorded in
`.impeccable/design.json`, alongside breakpoint metadata and component focus states.

Primary actions have no layers at rest. Hover brightens the face and reveals the
coral/cobalt layers at either side; pointer exit and press remove those layers.
Shared state transitions use `--motion-fast` (160ms ease-out). Pending indicators
use the existing rotation; reduced-motion rules suppress nonessential movement.
Onboarding copy/reveal disclosures keep their established immediate transitions.

## Shapes

Use the shared badge, control and panel radii. Controls and compact insets have
small corners; onboarding panels and dialogs use the larger panel radius. Source
logos retain their original assets: compact slots in Usage and 44px icons in
Integrations. Identity initials
use compact square workspace avatars and circular user avatars. Dividers and
field borders are hairlines, with a stronger boundary only where interaction needs it.

## Components

### Ownership and composition

Consume `web-v2/src/design/components.tsx` through the public React package.
It owns Brand, Button, LinkButton, Field, Input, Select, Textarea, PageHeader, Section,
Notice, StatusBadge, EmptyState, LoadingState, Table, Dialog, CopyField and Tabs.
The shared icon set is in `src/design/icons.tsx`. Add a shared primitive only when
a real feature needs it. Hosted pages import the same controls, router and styles;
provider integration, membership and billing behavior remain in deployment adapters.

Strict TypeScript, shared native controls, a single router, token usage and the
absence of feature stylesheets or inline styles are enforced by architecture
checks. See `web-v2/AGENTS.md` for the implementation and release rules. Onboarding's
single presentation stylesheet is the bounded exception for its preserved layout.

### Buttons

Primary uses the mark's periwinkle face and dark ink, with the hover behavior above.
Console secondary uses `surface-subtle`, a `control-line` border and normal text;
hover raises the surface and strengthens its border. Quiet is transparent with
muted text; plain is transparent with normal text. Both reveal a subtle surface
on hover. Danger uses its semantic wash, outline and text. Disabled controls use
the quiet neutral treatment and remove layers. Busy buttons show the shared
spinner, expose busy state and prevent repeated submission.

Use 40px minimum desktop controls and 44px mobile/coarse-pointer targets. Icon-only
controls retain accessible names. Keyboard focus uses a 2px accent outline with
a 3px offset. LinkButton shares button presentation while preserving link semantics.
The earlier `web/controls.css` secondary remains muted indigo; it is not the
React console secondary variant.

### Fields and copy controls

Field connects its visible label, hint or error to the shared native control.
Inputs use the surface, control border and control radius; invalid state uses
the danger border and an adjacent error. Disabled fields remain legible and
unavailable. Mobile text fields use 16px text. Textareas resize vertically.
CopyField keeps the value selectable and offers explicit clipboard feedback;
when copying fails, it selects the text for manual copying. The onboarding split
copy/reveal control retains its separate feedback timing and unchanged dimensions.

### Navigation and tabs

Desktop navigation stays grouped at the right. Links have 40px padded targets
with 12px horizontal padding and 4px gaps, leaving vertical room inside the 72px
header. The active page uses bright text and a 2px accent stroke close beneath
the label, inside the target. Do not stretch the target to the header height or
move the stroke to the header bottom. Mobile navigation
links use muted text, a subtle hover surface and a periwinkle active wash.
Active links expose their current-page semantics. The mobile navigation drawer traps
focus while open, closes with Escape, restores the toggle's focus on dismissal
and makes underlying content inert. Internal page changes focus the new page
heading; the skip link remains available. Tabs are an in-page control with an
accent underline, 12px vertical and 16px horizontal label padding, 4px gaps,
roving focus, arrow-key navigation and Home/End support. The tab list owns the
single divider above its content; a following Section has no extra top border
or top padding. Do not stack two rules below the tabs.

### Sections, insets and tables

Section uses a top divider, heading, optional description/actions and consistent
vertical padding. An inset or code block is a subtle surface with control-radius
corners and shared padding, not an additional navigation frame. Source identity,
metadata, progress and actions use the shared connection-card patterns. Table owns the
labeled overflow region, spacing, separators and tabular numeral presentation.

### Feedback and dialogs

Notice and StatusBadge share semantic status pairs. EmptyState gives a direct
explanation and an available next action. LoadingState names the pending read.
Pages distinguish loading, empty, failed and current data, with actionable recovery;
client visibility never establishes authorization. Dialog uses the native modal
with an accessible title, optional description, close control and shared action
area. Preserve native focus behavior and Escape dismissal.

### Guided onboarding

Three focused React steps share `OnboardingShell` within `FocusedFrame`: agent
setup, Sources, and optional teammate invitations. Keep a 640px boxed panel,
left-aligned headings and content, the bounded 960px top bar and outside-panel
navigation. Use existing circled checks, spinners and chevrons. No decorative
rules, auto-advancement or reveal/hide animation. Headings omit terminal periods.

Show the instruction for the next missing receipt. The first screen retains the
full grouped checklist, setup action and description after all gates turn green;
Next appears at the right below the panel. CLI and MCP sign-in are human steps;
the MCP test is an agent step. Recording contains first-session and optional
history subitems. Historical imports cannot prove live recording.

Prompt copy and reveal are independent split-button controls. Copy feedback
changes only the label for 1.5 seconds. The divider remains stable on either
segment's hover. Disclosures brighten their text and adjacent chevron on hover;
copy bars span their instruction width with a fixed right-hand feedback area.

Sources uses compact horizontal tiles with rounded-square provider logos on the
left, labels in the middle and plus/check marks at the right. Hide catalog search
below fifteen providers. API-key entry uses a named, focused dialog; OAuth returns
to the same Sources screen. Sources are optional: a quiet Skip for now continues
to teammates until a connection is confirmed, then Next takes its place.

Teammates appear in simple rows above one email field and Invite button. Enter
adds one teammate, clears the field and returns focus for another. Keep errors
beside the field. No redundant Ready labels. Skip for now and Open workspace
finish onboarding; invitations never become a gate.

Back and forward arrows have matching 21px outer insets. Preserve the primary
button's plain lavender rest state with coral/cobalt peeking out only on hover.
All receipts, connections and search results come from the runtime adapter;
there are no prototype variants, demo data or state controls in the product.
See [the behavior contract](docs/onboarding.md) and [QA](docs/onboarding-qa.md).

## Do's and Don'ts

### Do:

- **Do** reuse the Night tokens, existing brand assets and self-hosted Geist fonts.
- **Do** compose each workspace page from the shared shell, layout and controls.
- **Do** show labeled loading, empty, error, busy and current states with recovery.
- **Do** preserve the approved onboarding composition, receipts and optional invitations.
- **Do** verify keyboard focus, narrow layouts, internal history and onboarding appearance.

### Don't:

- **Don't** create another workspace navigation, page-local palette or feature stylesheet.
- **Don't** substitute new illustrations, fonts or provider marks for the inherited assets.
- **Don't** use status color without explanatory text or make client visibility an authority check.
- **Don't** replace onboarding's focused panel with workspace navigation or change its gates for styling.

## Approved Usage organization

Preserve the original Usage screen's Night typography, source identities, cards
and quiet surfaces. The user's current refinement replaces its tabs with one
continuous page ordered **Agent sessions**, **Data sources**, then **Team**.
The source tiles show actual indexed document-type counts for each connection;
import breakdowns and Imported/Indexed labels are omitted. Missing breakdowns are unavailable,
never inferred from ingestion rows. Do not use progress or relative-size bars to
compare different index corpora.

Agent sessions groups captured sessions, messages, tool calls, machines, daily
activity and available tool/harness/surface breakdowns. Do not relabel messages
as turns without an independently measured turn count. Team is the per-person
leaderboard and session/tool-call highlights, without a Most sources connected tile; workspace membership administration stays
on the Team management route.

Usage is the hosted home at `/`; `/usage` preserves query parameters when redirecting
to it. Old tab queries no longer hide sections. The same AppShell left sidebar is used
across every workspace route. Keep the remaining screen contents unchanged until
their individual review.

Shared report patterns include Page, PageHeader, dotted StatusBadge
pills, MetricGrid, ActivityChart and report sections. Nested report headings use
Section's level-three variant. Report panels use 24px padding and 12px corners;
metrics use 20px padding, 12px gaps and 32px figures. The page title follows the shared console heading.
Unavailable measurements stay distinct from measured zero, and tables scroll
inside their own container at narrow widths.

## Integrations restoration

Integrations uses the shared full-width page grid, with one catalog-ordered stack
of source cards. Cards use the shared
Night surface, 24px padding, 12px corners, inherited provider icons, and quiet
disconnect controls. Connection status, genuine import progress and per-stream
counts remain visible inside each card. Imported stream counts describe ingest
progress; they do not replace Usage's indexed document-type counts.

The shared `oc-connection-*` patterns own this presentation. Use shared Button,
Dialog and Icon primitives for connection, help and removal. Keep sign-in
recovery distinct from sync and deletion retries. `/sources` and its
`/integrations` alias share one React page and the canonical AppShell left sidebar.

## Team management

Team uses the same full-width page grid as every sidebar destination. Form rows
use the shared 640px measure inside it.
The member roster is the primary content: initials, a name and email grouped as
one identity, with the role aligned at the right. Display the actual member
count beside the section heading, distinguishing active members from pending
invitations. Pending invitations belong in the same roster, with an explicit
Pending status in the row. Workspace membership is invite-only; keep invitation
controls below the roster.
Activity and rankings belong to the Usage report, not membership administration.

Use the shared `oc-management-*`, `oc-member-*` and `oc-invite-form` patterns
with existing Section, Field, Input and Button controls.
Only show actions supported by the server. Invitations have explicit busy,
success and failure feedback; a failed list refresh must not suggest that a
successful invitation should be sent again. Clear displayed team information
and privileged controls when membership or authentication is revoked.

Team updates automatically every 30 seconds while visible and when returning
to the page. Normal use has no Refresh button. Background updates preserve
input and focus, skip overlapping reads, pause during mutations and while hidden,
and stop on unmount. Keep a retry action for initial loading failures.

## Diagnostics forum

The topic index, individual thread and global stream retain the original forum
composition. Shared `ForumPanel` provides the bordered surface, shaded title band,
count strip and pagination footer. Shared `Table` supplies the compact Topic,
Posts and Latest post columns; the last column places the date above the author.
Shared `ForumPost` supplies the 190px author rail, timestamp/message-number header
and full, wrapping message body. On narrow screens the author sits above the
message. Use Night surfaces, Geist and the existing small control radius. Do not
add decorative avatars, truncation, topic cards or a normal-state Refresh button.
The All topics link sits above the topic panel at its left edge, outside the
title band. Use the shared left-arrow icon before its text and SPA navigation.

The count strip says “Showing N messages” for a paginated thread or stream.
Automatic updates reconnect a bounded staged chain to existing history before
prepending it. Each continuation verifies an overlapping boundary post. A normal
chunk reads at most five pages; a detected history reset discards cached/staged
posts and permits one additional fresh-head recovery read. Updates retain loaded
older messages and preserve the reading position
only after the reader has scrolled into the list. The beginning of the list
reveals new posts naturally. Topic navigation remains SPA history. Loading,
empty and error states keep the same title/panel frame. Access and unclassified
read failures discard board data; explicit server failures may retain confirmed
posts with visible retry status.

## Text separators

Centered-dot separators (U+00B7) are forbidden in every authored UI, including
metadata, browser titles, templates, HTML entities, and escaped Unicode forms.
Use natural punctuation, sentences, spacing, or separate lines. Do not replace
separator dots with decorative badges. Genuine status indicators and user/source
content remain intact. The shared architecture guard enforces this rule in core
and hosted React source.

The Usage report retains its top-level narrative above Agent sessions: imported
records and source count, measured indexed documents, and median query time. Use
`report-summary` with the original emphasized numeric spans. Never substitute zero
for unavailable measurements, and retain the accepted section order and per-source
indexed document types without reintroducing aggregate comparison bars.

Source tiles show only actual indexed document-type counts, with source identity
and sync metadata. Omit Imported/Indexed labels, import breakdowns and aggregate
totals so each card presents one content breakdown.


## Legacy HTML control ownership

`web/controls.css` owns visual presentation for server-rendered controls used on
authentication, organization selection, provider handoff and cloud-capture pages.
Use its existing primary/quiet button treatments and `button-link primary` for
primary anchors. Shared field and choice presentation uses `text-input`,
`code-input` and `choice-button`. Keep canonical disabled states and touch targets.
React controls and the preserved React onboarding stylesheet remain separate;
do not import this legacy stylesheet into the React workspace.

Deployment page styles may arrange controls but may not redefine their visual
properties. For example, `.org-form > button { justify-self:start }` is placement
and belongs in hosted layout. Colors, backgrounds, borders, fonts, padding,
outlines, shadows, disabled appearance and control sizing belong here, including
state and responsive rules. A rule such as `.org-form input { border:1px solid
var(--line); padding:12px; font:inherit }` is a control implementation and must not
be added to hosted `shell.css`, even when it uses approved tokens.

Enforcement coverage is deliberately explicit: the architecture tests reject
authored JavaScript, duplicate React controls/navigation, React inline styles,
hosted React stylesheets and prohibited separator text. Hosted's CSS Tree check
separately enforces presentation ownership for native/canonical control subjects
in `shell.css`, including functional selectors and media rules. Only margins,
self-alignment, order and grid placement are allowed there. It rejects syntax it
cannot inspect. Arbitrary class aliases and inherited ancestor styling still
need review, and rendered states still need browser validation. Do not claim the
React AST checker alone enforces legacy CSS ownership or that a parser proves
visual behavior.

## Memory documents

Memory documents use the shared Markdown reader: 15px prose at the 75ch measure,
semantic headings beneath the page title, spaced paragraphs and lists, monospace
code, and the existing overflow-aware Table for GFM tables. Keep prose on the page
surface and code on its inset surface. The separate Markdown source disclosure
retains the unchanged capture and keyboard-scrollable raw text.

## Diagnostic search inspection

Diagnostics is an administrative inspection surface, not the workspace's primary
search entry point. Its Search inspector tab leads directly to a compact query
form and short introduction; do not repeat the tab name as another heading.
Source-specific result rows use real titles, provider/harness, kind/role, available
channel/session/path context and valid timestamps. Body text uses the 15px prose
token with preserved line breaks. Highlight literal query text through React
nodes, never HTML strings. Full text, item metadata and the response JSON remain
intentional disclosures; closed disclosures do not render or serialize their
large payloads. Preserve server excerpt metadata and label excerpts as such,
never as the entire indexed document. Source links exist only for supplied absolute HTTP(S)
URLs without embedded credentials; do not manufacture provider links from IDs.

Returned rows are not total matches. Distinguish reported exact/lower-bound totals
from unknown totals, pending/unconfigured/unavailable sources, truncation,
timeouts and failed shards. An incomplete source response is not a complete empty
search. The self-host adapter preserves coverage and never turns window length
into a total. New or canceled queries, failures, adapter changes and unmounts
clear prior result data. Late responses cannot replace the latest submitted query.
Input edits remain separate from the displayed submitted query; Cancel restores
focus to the query field. Keep the approved workspace shell, tabs and forum intact.

Metric cards align labels and values at the top regardless of description length.
Report columns respond to the main pane width: below 900px, use two metric columns
and one column for paired panels, preserving legibility beside the sidebar.

The account footer matches the supplied person/workspace reference. Its 64px
row spans the sidebar below a full-width divider; a 32px outlined workspace icon
sits 16px from the edge. Person name uses 16px type above the 13px workspace name.
One trailing chevron opens the native account popover above the row. Keep the
workspace name here instead of repeating it beneath Brand. Outside clicks and
Escape close the account menu. Inside mobile navigation, the first Escape closes
account details and the second closes the drawer. Workspace-only adapters show
static footer context without an empty menu.

The sidebar starts 16px from the top. Keep the wordmark optically aligned with
the mark using its scoped 2px adjustment. Integrations uses the shared plug icon.
The footer divider remains the only persistent horizontal rule in navigation.
