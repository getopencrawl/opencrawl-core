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
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-.025em"
  console-heading-compact:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.5rem"
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
  navigation-item-active:
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
  workspace-header:
    backgroundColor: "{colors.bg}"
    padding: "0 32px"
    height: "72px"
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

The retained `web/frame.css` and `web/controls.css` describe the earlier shared
frame and controls; they do not own the React workspace shell. React onboarding
preserves its approved presentation in `web-v2/src/onboarding/onboarding.css`.
Use the existing self-hosted fonts, OC marks, provider logos and shared SVG icons.
The font license remains at `web/assets/Geist-OFL.txt`.

**Key Characteristics:**

- Dark-only Night palette and inherited brand assets.
- One React workspace shell with a shared top bar on every workspace route.
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

The console heading uses `console-heading`, reducing to `console-heading-compact`
on mobile. Section headings use `heading`; smaller content headings use `title`.
The interface uses `ui`, descriptions use `body`, labels use `label`, and metadata
uses `metadata`. Technical text uses `mono`. Metrics and tables use tabular numerals;
metric values use the `metric` role. Prose is bounded to 75 characters where possible.

The earlier large display role remains available to its established surfaces.
Onboarding retains its existing heading scale and responsive adjustments in its
bounded presentation stylesheet; do not restyle it with the console page heading.

## Layout

`AppShell` is the only workspace shell. One route registry drives the top bar
and page routing through the shared router. The hosted routes are Usage, Sources,
Diagnostics, Settings, Team and Billing. Deployment adapters supply only their
supported routes; the shared shell does not imply hosted capabilities in the
single-tenant adapter.

The desktop top bar is 72px high. Content is centered at 1200px with 32px side
insets, 48px top padding and 64px bottom padding. At 800px and below, that same
navigation tree becomes a focus-managed drawer bounded by 300px and the viewport
minus 48px. Content padding becomes 32px, 16px and 40px. The mobile header contains
the navigation control, workspace name and existing mark. There is no alternate
page-specific sidebar or navigation implementation.

Compose shared stacks, rows, action groups, split rows, two-column form grids,
metric lists and data rows. Forms collapse to one column at the mobile breakpoint.
Source rows and search forms stack at 600px. Tables retain their columns inside
a horizontal scroll region, with a scroll hint when they overflow. Section
boundaries and vertical rhythm organize content without wrapping every group in
a card. Page headers reserve a consistent description and action area.

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
logos retain their original assets within the shared 32px slot. Identity initials
use compact square workspace avatars and circular user avatars. Dividers and
field borders are hairlines, with a stronger boundary only where interaction needs it.

## Components

### Ownership and composition

Consume `web-v2/src/design/components.tsx` through the public React package.
It owns Button, LinkButton, Field, Input, Select, Textarea, PageHeader, Section,
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

Navigation links use muted text, a subtle hover surface and periwinkle active
state. Active links expose their current-page semantics. The mobile navigation drawer traps
focus while open, closes with Escape, restores the toggle's focus on dismissal
and makes underlying content inert. Internal page changes focus the new page
heading; the skip link remains available. Tabs are an in-page control with an
accent underline, roving focus, arrow-key navigation and Home/End support.

### Sections, insets and tables

Section uses a top divider, heading, optional description/actions and consistent
vertical padding. An inset or code block is a subtle surface with control-radius
corners and shared padding, not an additional navigation frame. Source identity,
metadata, progress and actions use the shared source-row pattern. Table owns the
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
to the same Sources screen. Next becomes available after a confirmed connection.

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
imported records remain explicitly separate. Missing breakdowns are unavailable,
never inferred from ingestion rows. Do not use progress or relative-size bars to
compare different index corpora.

Agent sessions groups captured sessions, messages, tool calls, machines, daily
activity and available tool/harness/surface breakdowns. Do not relabel messages
as turns without an independently measured turn count. Team is the per-person
leaderboard and activity highlights; workspace membership administration stays
on the Team management route.

Usage is the hosted home at `/`; `/usage` preserves query parameters when redirecting
to it. Old tab queries no longer hide sections. The same AppShell top bar is used
across every workspace route. Keep the remaining screen contents unchanged until
their individual review.

Shared report patterns include PageHeader's report variant, dotted StatusBadge
pills, MetricGrid, ActivityChart and report sections. Nested report headings use
Section's level-three variant. Report panels use 24px padding and 12px corners;
metrics use 20px padding, 12px gaps and 32px figures. The display heading is 40px.
Unavailable measurements stay distinct from measured zero, and tables scroll
inside their own container at narrow widths.
