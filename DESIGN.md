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
  board-author:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: ".875rem"
    fontWeight: 700
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
  badge: "3px"
  control: "4px"
  message: "7px"
  panel: "8px"
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
    padding: "4px 16px"
  button-primary-hover:
    backgroundColor: "{colors.brand-face-hover}"
    textColor: "{colors.brand-ink}"
  button-secondary:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "4px 16px"
  button-quiet:
    textColor: "{colors.muted}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "4px 16px"
  button-plain:
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "4px 16px"
  button-danger:
    backgroundColor: "{colors.danger-wash}"
    textColor: "{colors.danger}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "4px 16px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "4px 12px"
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
---

# OpenCrawl Night

## Overview

The console helps people connect machines and tools, inspect what their agents
can find, and manage workspace access. Use the static OpenCrawl mark, self-hosted
Geist, a black canvas, near-black surfaces and hairline borders. Use periwinkle
for actions and selection. Status has a readable label alongside its color.
Geist Mono is for commands, identifiers and other technical text.

The [Night tokens](web/tokens.css), [console dimensions](web-v2/src/design/tokens.css)
and [component styles](web-v2/src/design/styles.css) define the rendered values.
The frontmatter and Impeccable swatches preview primitives. Use the React
implementations and fixtures below to see how a screen fits together.

## Layout

[AppShell](web-v2/src/app.tsx) supplies the desktop sidebar, docked account
menu and mobile drawer. [Page](web-v2/src/design/components.tsx) keeps the title
above the scrolling body on desktop. On phones, the title and actions scroll
with the page below the navigation row. The message board keeps its page heading above an independently scrolling
channel list and conversation. On phones, Browse channels opens the list beside the search field. Use the same
centered page grid for content, loading and failure. Bound forms and prose
inside that grid. A Section adds its own top rule. Check what already separates
the content before adding one.

Settings sections share one heading and route navigation. The focused
[onboarding shell](web-v2/src/onboarding/shell.tsx) has its own panel and
outside-panel navigation. Auth and provider handoffs use the
[focused frame](web-v2/src/design/focused-frame.tsx). The
[workspace route registry](web-v2/src/application/app.tsx) shows which setup
presentation the current deployment exposes.

## Components

Choose the row that matches the task. Open the caller to see the composition
and the test for representative data, state transitions and viewport coverage.

| Task and state | What to reuse | Executable reference |
| --- | --- | --- |
| Connect a tool or manage an existing connection | [Integrations](web-v2/src/application/connector-card.tsx) calls `IntegrationCard`. Available tools have compact tiles. Connected tiles keep the complete metrics list scrollable and anchor one sync status and the standard secondary Manage button in the footer. Integrations shows imported counts. | [Card sizes and actions](web-v2/test/integrations.browser.spec.ts) |
| Search the workspace | [Search](web-v2/src/pages/search.tsx) centers the blank form. After submission the form and results share the [Sessions](web-v2/src/pages/sessions.tsx) grid. Clearing the query restores the initial state. A hit leads with a linked title when a destination exists, then its source and matching excerpt. Keep one results summary. | [Blank, populated and cleared states](web-v2/test/search.browser.spec.ts) |
| Connect a coding agent | [Setup](web-v2/src/application/setup.tsx) shows the installation guide until the first computer checks in. After that, “Connect another computer” opens the guide above the computer list. Replicas capture belongs to Integrations. macOS and Linux share a command with an inline Copy action. Windows has its own tab. Computer tiles list connected agents and their last contact. | [Agent setup scenarios](web-v2/test/cli-setup.browser.spec.ts) |
| Read a conversation or load more messages | [Sessions](web-v2/src/pages/sessions.tsx) uses neutral bubbles for user messages, unboxed assistant prose and collapsed activity. Open at the newest event. Reuse `ScrollControl` for Load older events and Jump to latest. [Message board](web-v2/src/pages/board.tsx) uses it for Load older messages. Keep channel context while opening a thread. | [Transcript](web-v2/test/sessions.browser.spec.ts) and [board](web-v2/test/board.browser.spec.ts) |
| Manage members | [Team](web-v2/src/application/team.tsx) pairs identity, role and actions in the roster. Keep invitations with members. Use the shared destructive action for removal and confirm its scope in a dialog. | [Team and removal states](web-v2/test/onboarding.browser.spec.ts) |
| Review workspace activity | [Usage](web-v2/src/pages/usage.tsx) opens with three selectable cards for agent searches, OpenCrawl context edits and indexed session tokens. The search and token charts share UTC dates and default to 30 days. Five visible queries lead into paginated history. Connected app inventory belongs in Sources. Team and Activity keep their own reporting controls. | [Browser coverage](web-v2/test/usage.browser.spec.ts), [token reads](test/usage-tokens.test.mjs) |
| Complete guided onboarding | Reuse the [existing steps](web-v2/src/onboarding) and their [behavior contract](docs/onboarding.md). Show the next missing verification step, keep source connection and invitations optional where offered, and preserve focus and copy feedback. | [Guided flow on desktop and phone](web-v2/test/onboarding.browser.spec.ts) |

[Button and LinkButton](web-v2/src/design/components.tsx) default to secondary.
Use primary for the main action, quiet for low-emphasis actions and danger for
destructive confirmation. Keep the sized control intact when placing it in a
card or footer. The primary button's coral and cobalt edges appear on hover.
Single-line fields and buttons use a 32px desktop minimum with 14px type.
Keep visible keyboard focus and 44px targets on compact screens and coarse pointers.
