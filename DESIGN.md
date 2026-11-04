---
name: OpenCrawl
description: Soft paper product workspace with restrained periwinkle accents.
colors:
  bg: "#f2f0f3"
  surface: "#ffffff"
  surface-subtle: "#f7f6f9"
  text: "#232129"
  muted: "#645f6b"
  line: "#e1dde6"
  control-line: "#96909f"
  accent: "#4f49cf"
  accent-hover: "#4138b6"
  primary: "#7d82ff"
  primary-hover: "#6e74f2"
  on-primary: "#0c0d2a"
  wash: "#eae9ff"
  selection: "#dcd9ff"
  success: "#32734b"
  success-wash: "#edf7ef"
  pending: "#825a1f"
  pending-wash: "#fcf4e7"
  danger: "#ae3344"
  danger-wash: "#fff0f2"
  dark-bg: "#17151b"
  dark-surface: "#211e27"
  dark-surface-subtle: "#2b2733"
  dark-text: "#eeecf3"
  dark-muted: "#bdb7c8"
  dark-line: "#49434f"
  dark-control-line: "#7f778c"
  dark-accent: "#b1adff"
  dark-accent-hover: "#cecaff"
  dark-primary: "#969aff"
  dark-primary-hover: "#a8abff"
  dark-wash: "#35314c"
  dark-selection: "#4c456e"
  dark-success: "#a0d7b0"
  dark-success-wash: "#25372b"
  dark-pending: "#e6c088"
  dark-pending-wash: "#3b3022"
  dark-danger: "#ffabb8"
  dark-danger-wash: "#432a32"
typography:
  welcome:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.625rem"
    fontWeight: 550
    lineHeight: 1.3
    letterSpacing: "-.025em"
  section:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-.015em"
  body:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: ".9375rem"
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: "normal"
  ui:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: ".875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: ".8125rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
  metadata:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: ".75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  mono:
    fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: ".8125rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
  brand:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.3125rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-.035em"
  brand-compact:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-.035em"
  welcome-mobile:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.5rem"
    fontWeight: 550
    lineHeight: 1.3
    letterSpacing: "-.025em"
rounded:
  badge: "4px"
  control: "6px"
  message: "10px"
  panel: "12px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "8px 12px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "8px 12px"
  message:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.message}"
    padding: "12px 16px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "8px 12px"
  nav-tab:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    padding: "12px 0"
  badge-ready:
    backgroundColor: "{colors.success-wash}"
    textColor: "{colors.success}"
    typography: "{typography.metadata}"
    rounded: "{rounded.badge}"
    padding: "2px 8px"
  paper-pane:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
  table-header:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    padding: "12px"
  composer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.ui}"
    rounded: "{rounded.message}"
    padding: "8px"
  code-field:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.text}"
    typography: "{typography.mono}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
---
# Design System: OpenCrawl

## Overview

**Soft paper** is the approved product direction. A quiet neutral canvas holds inset white working panes. Geist, the approved OpenCrawl mark and restrained periwinkle actions connect the product to its marketing site. Content remains the focus.

`web/tokens.css` owns the reusable visual values. `web/style.css` owns native controls and component patterns. `web/ui.tsx` owns the shared Brand, Icon, Table and CopyField components. Apply these sources to new elements and refresh this document and its sidecar when the system changes.

## Colors

Periwinkle `primary` backgrounds use dark `on-primary` text. The deeper `accent` is for links, focus and selected navigation. Never use pale primary colors for small text on white. Neutral `bg`, `surface` and `surface-subtle` create the material layers; `line` separates content and `control-line` identifies field boundaries.

Success, pending and danger each have a text and wash pair. Pair status color with an explicit label. System dark mode replaces the semantic palette, including borders, selection, focus and elevation. Preserve the same hierarchy in both appearances.

## Typography

Geist carries the wordmark, navigation, controls, headings and prose. Geist Mono identifies code, endpoints, keys and technical records. Both fonts are self-hosted with the SIL Open Font License retained in `web/assets`.

The scale is 12px metadata, 13px small text and labels, 14px primary UI, 15px body, 16px section titles, 18px document headings and 26px welcome headings (24px on mobile). The brand uses 21px type, reduced to 19px in the sidebar. Prose uses 1.7 line height and a maximum measure of 75 characters. Mobile editable fields use 16px to avoid browser zoom. Use tabular numerals for dates and numeric data. Headings use modest weight and tracking rather than display effects.

## Layout

The desktop shell contains a resizable collection sidebar (220px default), chat and an independent collection inspector. The sidebar resizes within 160–420px and is further capped at 22vw with the inspector, or 28vw without it. The three-column layout retains at least 360px for chat. The inspector uses `clamp(380px, 38vw, 640px)`. The working shell stays fixed to the viewport; its panes own scrolling and visually hidden labels/statuses stay anchored to their controls. Working panes have 12px exterior gutters; their 56px headers align. The chat measures at most 800px with 24px horizontal content insets; its header, transcript and composer share their content alignment, including the transcript scrollbar allowance. Inspector content uses 24px insets.

At 1100px and below, the collection inspector opens as a focus-managed overlay, at most 680px wide with 12px exterior gutters. At 850px and below, sidebar padding becomes tighter. At 600px and below, chat fills the screen with 16px content insets, navigation uses the existing drawer and the collection overlay fills the viewport. The mobile header has a labeled Collection toggle; the inspector has its own close action. Preserve the pre-reflow transcript intent: a view following the latest message remains at the bottom, while a scrolled-up view retains its visible message anchor. Preserve independent panel scrolling, resize behavior and safe-area insets. When the chat pane itself is 380px wide or narrower, the composer actions wrap below its textarea.

Spacing follows 4, 8, 12, 16, 20, 24, 32, 40 and 48px tokens. Group labels with fields and separate whole sections more generously. A compact account button sits below the collection list, with initials, user name, workspace and an expansion chevron. Wide tables scroll within their own region.

Workspace settings use one independently scrolling paper pane. Desktop content starts directly with the settings heading; mobile retains the collections navigation button in its header. Content measures at most 800px; section introductions and controls form two columns separated by generous spacing and thin row rules. Sections stack when the pane is 520px wide or narrower, as well as in the mobile layout. Use pane width for this reflow so a narrow working area remains usable on a wide screen.

## Elevation & Depth

Working panes and account sheets use `shadow-paper`: a subtle offset blur that separates paper from the canvas. They have no additional outline. The composer uses a control stroke without a shadow. Rows, messages and table cells remain flat.

**The Paper elevation Rule.** Give inset working surfaces one soft shadow; ordinary content stays flat.

`shadow-floating` belongs to floating message navigation; `shadow-dialog` belongs to actual dialogs and overlays. Ordinary buttons and fields use thin strokes. Content rows use 1px separators. Backgrounds remain quiet and clean; the logo carries the brand's layered color.

## Shapes

Use 4px badge corners, 6px controls and code blocks, 10px user messages/composers and 12px working surfaces. Full-screen mobile panes have square outer edges. Primary actions have the same control shape as secondary actions. Keyboard focus uses a 2px accent outline with a 3px offset.

## Components

### Controls and forms

Native `button`, `input`, `textarea`, `select` and `label` elements receive shared styles automatically. `.primary` applies the periwinkle action treatment. `.icon-button` and `.text-button` provide quiet actions. Ordinary desktop controls have a 40px minimum height. Compact icon and copy actions use 32px; composer actions use 36px. At 600px and below, ordinary buttons, inputs and selects, plus icon, copy and composer actions, have a 44px minimum height. Coarse-pointer controls also use at least 44px targets. Multiline textarea height follows its rows and content. Disabled controls retain legible text and use the subtle surface; error text and notices use semantic danger colors. Existing async labels communicate progress.

Use a persistent visible label for each field, specific helper text when needed and the existing form validation and recovery behavior. The composer owns its enclosing focus outline; its inner textarea does not add another ring.

### Navigation and messages

The shared `Brand` carries the approved logo and lowercase wordmark. Shared `Icon` drawings use a consistent rounded outline, with visible action text or an accessible name on their owning control.

Collection identities use `CollectionGlyph` from `web/collection-glyph.tsx`: bespoke private images in the approved tactile world, simplified to smooth, broad matte forms. The bounded subject planner in `src/collection-icon-subject.ts` resolves the current purpose from the brief, latest user corrections and document samples; collection names and first messages provide supporting context. It chooses one concrete object, at most two large identifying features and one restrained accent, then saves the plan in the durable job before drawing. Workspace browser requests consider sibling motifs to keep nearby collections distinct; collection keys remain scoped to their own collection. The renderer in `src/collection-graphics.ts` receives only the chosen object, features and accent; raw collection context stays with the planner and private provenance. The shared `tactile-v3` style, versioned in `shared/collection-graphics.ts`, targets 48px and remains readable in the 32px sidebar: two to four rounded volumes, gentle broad shading and an upper-left highlight, without microtexture, accessory props or search symbols. Generate once per collection and style; reloads and retries reuse the saved plan, job, image and provenance. The sidebar and archived collection rows share the decorative 32px image, preserving identity through renaming and reordering. True transparent alpha, lifted midtones and clean edges support both dark and light surfaces without a backplate, glow, CSS recoloring or rotation. A generic file silhouette is the temporary placeholder while the image is unavailable or loading; forced-colors mode uses the system-colored file silhouette. Collection names remain the accessible labels.

Collection selection uses a lavender wash. Resource tabs use an accent underline. The compact Collection toggle opens the inspector, which has a separate close action; search modes use a subtle selected surface. Keep essential controls available without hover.

The operator title bar prioritizes the collection name, which truncates without displacing its controls. A persistent, named Collection actions button opens a native popover with Rename collection and Archive collection (or Restore collection for archived items). Archived state has a separate text badge. Rename opens a labeled full-width row beneath the title, with Save, Cancel, validation and focus restoration; navigation and the Collection panel shortcut retain their positions. The popover uses the floating elevation, fits the viewport, and dismisses with Escape or an outside click.

User messages have a neutral filled bubble. Agent responses sit on the paper with normal prose styling; progress messages use smaller secondary text. Questions use a subtle inset background and standard form controls. Preserve Markdown, source links, code blocks and conversation grouping.

### Workspace settings

The sidebar account button shows a circular initials avatar, user name above the workspace name and an expansion chevron. Its upward-opening native popover uses the floating shadow and groups email with light/dark/system appearance controls, a “Switch workspace” row only for users with multiple verified memberships, settings, and danger-colored sign-out. Workspace choices live in a separate view of the popover, with a check on the current workspace; Back or Escape returns to the account menu and restores focus to its switching row. Long names truncate; the menu fits the viewport independently of sidebar width, scrolls on short screens, and dismisses with Escape or an outside click. Appearance persists locally and applies to the app and workspace widget. The settings pane retains workspace identity, switching and role, teammate invitations, account details and sign-out, and the privacy link. Keep these controls in flat sections with shared native fields and buttons. Opening settings focuses its heading; returning to the collection restores focus to the sidebar entry on desktop or the visible collections button on mobile. Preserve collection drafts and history while settings are open.

### Tables and data

Use `Table` from `web/ui.tsx` for native tables and Markdown table renderers. It preserves table semantics inside a named horizontal scroll region. Only overflowing regions join the keyboard tab order and show the visible “Scroll to see all columns.” hint; a ResizeObserver keeps this state current as the pane and data change. Table body text uses the primary UI size; headers use the smaller label size, a subtle fill and medium-weight secondary text. Rows use horizontal separators, a quiet hover state and no vertical gridlines. Source trees preserve expandable page groups; logs preserve all columns. Status badges contain words as well as color.

### Copy fields and code

Use `CopyField` from `web/ui.tsx` for keys, URLs and code examples. Single-line values render as read-only inputs; multiline code renders as a read-only textarea without wrapping. Preserve horizontal scrolling, selection on focus, visible Copy/Copied state and the announced clipboard fallback. Do not let long keys or endpoints widen their pane. Prose may wrap inline code, but multiline code blocks retain their line structure and scroll within their container.

### Appearance and motion

Semantic tokens default to the system appearance; the account menu can override it with a persisted light or dark preference. Hover transitions take 150ms and communicate state. Respect reduced motion. There are no decorative load sequences. Retain real loading, empty, error, permission, success and disabled states without inventing new product claims.

## Do's and Don'ts

- Do reuse the shared tokens, native primitives, Brand, Icon, Table and CopyField components.
- Do keep type, spacing and corners consistent across account, chat, search and API surfaces.
- Do verify desktop, compact and mobile layouts in both appearances, including long content, keyboard focus and table overflow.
- Do preserve product behavior, source evidence and accurate status text.
- Don't introduce one-off fonts, colors, radii, shadows or repeated card treatments for ordinary UI.
- Don't place decorative texture, grids, gradients or brand effects behind working content.
- Don't use elevation on ordinary rows, field groups or chat messages.
