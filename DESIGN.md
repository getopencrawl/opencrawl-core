---
name: OpenCrawl Porcelain
description: A shared operations console set on the landing hero's lavender, with its type, ink text, ink blocks and hairline frames.
colors:
  bg: "#7d82ff"
  surface: "color-mix(in srgb, #121212 7%, #7d82ff)"
  surface-subtle: "color-mix(in srgb, #121212 13%, #7d82ff)"
  surface-raised: "color-mix(in srgb, #121212 19%, #7d82ff)"
  text: "#121212"
  strong: "#0a0a0a"
  muted: "#1a1a2c"
  quiet: "#25253d"
  line: "rgb(18 18 18 / .28)"
  line-strong: "rgb(18 18 18 / .42)"
  control-line: "rgb(18 18 18 / .62)"
  brand-face: "#7d82ff"
  brand-face-hover: "#959aff"
  brand-coral: "#ff6268"
  brand-cobalt: "#164bff"
  brand-ink: "#121212"
  accent: "#121212"
  accent-hover: "#fff"
  primary: "#161616"
  primary-hover: "#2b2b2b"
  on-primary: "#eaeaea"
  secondary: "color-mix(in srgb, #fff 34%, #7d82ff)"
  secondary-hover: "color-mix(in srgb, #fff 46%, #7d82ff)"
  secondary-line: "rgb(18 18 18 / .55)"
  on-secondary: "#121212"
  band: "#161616"
  band-ink: "#f6f6f6"
  band-body: "#d6d6d6"
  wash: "rgb(255 255 255 / .2)"
  selection: "rgb(255 255 255 / .45)"
  success: "#042a16"
  success-wash: "#93dcb3"
  pending: "#3a2300"
  pending-wash: "#f1cf7c"
  danger: "#74090d"
  danger-strong: "#4f0508"
  danger-wash: "#ff6268"
  backdrop: "rgb(18 18 18 / .55)"
  nav-bg: "#161616"
  nav-hover: "#262626"
  nav-ink: "#d6d6d6"
  nav-strong: "#f6f6f6"
  nav-line: "#2e2e2e"
  nav-accent: "#aeb1ff"
  chart-rest: "rgb(18 18 18 / .16)"
typography:
  display:
    fontFamily: "'Funnel Display', Geist, system-ui, sans-serif"
    fontSize: "2.5rem"
    fontWeight: 400
    lineHeight: 1.08
    letterSpacing: "-.04em"
  console-heading:
    fontFamily: "'Funnel Display', Geist, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "-.03em"
  console-heading-compact:
    fontFamily: "'Funnel Display', Geist, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "-.03em"
  heading:
    fontFamily: "'Funnel Display', Geist, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "-.02em"
  title:
    fontFamily: "Switzer, Geist, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.45
  body:
    fontFamily: "Switzer, Geist, system-ui, sans-serif"
    fontSize: ".9375rem"
    lineHeight: 1.45
    letterSpacing: "-.01em"
  ui:
    fontFamily: "Switzer, Geist, system-ui, sans-serif"
    fontSize: ".875rem"
    lineHeight: 1.45
    letterSpacing: "-.01em"
  control:
    fontFamily: "Switzer, Geist, system-ui, sans-serif"
    fontSize: ".875rem"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "-.02em"
  board-author:
    fontFamily: "Switzer, Geist, system-ui, sans-serif"
    fontSize: ".875rem"
    fontWeight: 500
    lineHeight: 1.45
  label:
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace"
    fontSize: ".75rem"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "-.02em"
  metadata:
    fontFamily: "Switzer, Geist, system-ui, sans-serif"
    fontSize: ".75rem"
    lineHeight: 1.45
  mono:
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: ".8125rem"
    letterSpacing: "-.02em"
  metric:
    fontFamily: "'Funnel Display', Geist, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-.03em"
rounded:
  badge: "1px"
  control: "1px"
  panel: "1px"
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
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "transparent"
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
  badge:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.badge}"
    padding: "3px 6px"
  inset:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "16px"
  dialog:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "24px"
    width: "min(520px, calc(100vw - 32px))"
---

# OpenCrawl Porcelain

## Overview

The console helps people connect machines and tools, inspect what their agents
can find, and manage workspace access. It shares one visual language with the
hero of [getopencrawl.com](https://getopencrawl.com): the mark's lavender as the
page, ink text and hairlines, and square corners throughout. Panels are the page
darkened a step with ink. Nothing is white.

- **Type.** Funnel Display sets page and section headings and large figures,
  light and tight. Reading text and controls use Switzer where a deployment
  serves it and Geist otherwise. IBM Plex Mono sets labels, table headings,
  timestamps, tags, commands and identifiers, in sentence case. The wordmark
  stays in Geist because it is part of the logo.
- **Ink.** Navigation is an ink box with light text, like the landing page's
  navigation. Primary actions are ink blocks. A text-only primary action ends
  with a plus that turns on hover. Secondary actions are ink outlines.
- **Lavender.** Lavender is the ground, so it cannot mark emphasis in the page.
  Links, focus rings, selected tabs and chart series are ink. Highlight blocks
  are ink with light text. A white wash marks what is selected. The current
  navigation item is a lavender block inside the ink sidebar.
- **Status.** Status has a readable label alongside its colour. Tags sit on a
  mint, amber or coral fill with dark text. Indicators are small squares. People keep round avatars and agents keep square pixel faces.

Switzer may be served by an operator from their own application and may not be
redistributed, so core does not ship it. A deployment that holds its own copy
serves `/assets/switzer-400.woff2` and `/assets/switzer-500.woff2` and sets
`data-brand-fonts` on the root element. Switzer has two weights, so emphasis in
reading text is medium (`--weight-strong`). Do not ask for heavier text.

The [Porcelain tokens](web/tokens.css), [console dimensions](web-v2/src/design/tokens.css)
and [component styles](web-v2/src/design/styles.css) define the rendered values.
The frontmatter and Impeccable swatches preview primitives. Use the React
implementations and fixtures below to see how a screen fits together.

## Layout

[AppShell](web-v2/src/app.tsx) supplies the desktop sidebar, docked account
menu and mobile drawer. [Page](web-v2/src/design/components.tsx) supplies the
stationary title bar and its divider above the scrolling body. Use the same
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
| Connect a coding agent | [Setup](web-v2/src/application/setup.tsx) shows the first agent’s instructions inline. Connect an agent opens the same instructions from the computer roster. macOS and Linux share a command with an inline Copy action. Windows has its own tab. Computer tiles list connected agents and their last contact. An empty tile shows only the computer name and No connected agents. | [Agent setup scenarios](web-v2/test/cli-setup.browser.spec.ts) |
| Read a conversation or load more messages | [Sessions](web-v2/src/pages/sessions.tsx) uses neutral bubbles for user messages, unboxed assistant prose and collapsed activity. Reuse `ScrollControl` for Load more or Jump to latest. [Message board](web-v2/src/pages/board.tsx) uses it for Load older messages. Keep channel context while opening a thread. | [Transcript](web-v2/test/sessions.browser.spec.ts) and [board](web-v2/test/board.browser.spec.ts) |
| Manage members | [Team](web-v2/src/application/team.tsx) pairs identity, role and actions in the roster. Keep invitations with members. Use the shared destructive action for removal and confirm its scope in a dialog. | [Team and removal states](web-v2/test/onboarding.browser.spec.ts) |
| Review workspace activity | [Usage](web-v2/src/pages/usage.tsx) opens with three selectable cards for agent searches, OpenCrawl context edits and indexed session tokens. The search and token charts share UTC dates and default to 30 days. Five visible queries lead into paginated history. Connected app inventory belongs in Sources. Team and Activity keep their own reporting controls. | [Browser coverage](web-v2/test/usage.browser.spec.ts), [token reads](test/usage-tokens.test.mjs) |
| Complete guided onboarding | Reuse the [existing steps](web-v2/src/onboarding) and their [behavior contract](docs/onboarding.md). Show the next missing verification step, keep source connection and invitations optional where offered, and preserve focus and copy feedback. | [Guided flow on desktop and phone](web-v2/test/onboarding.browser.spec.ts) |

[Button and LinkButton](web-v2/src/design/components.tsx) default to secondary.
Use primary for the main action, quiet for low-emphasis actions and danger for
destructive confirmation. Keep the sized control intact when placing it in a
card or footer. A primary button with an icon or a busy indicator drops its plus.
Preserve visible keyboard focus and the shared compact-screen touch targets.
