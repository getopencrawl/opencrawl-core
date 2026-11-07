# Onboarding QA — November 6, 2026

Reviewed the panel variant on the private preview, using actual browser renders
and interactions. This is frontend acceptance for the disposable fixture server;
it does not establish production authentication or session-ingestion acceptance.

## Coverage

- Fresh setup, loading, CLI signed in, MCP signed in first, MCP signed in,
  connection test passed, all checks passed, history imported before recording,
  history importing, history imported after recording, history skipped, and
  status unavailable.
- Desktop 1280×720, iPad mini landscape 1024×768 and portrait 768×1024,
  and mobile 390×700. Expanded instructions may scroll; collapsed tablet
  screens fit without scrolling.
- Every expandable checklist item, all four prompt previews, copy success and
  timed reset, snippet selection fallback, full-prompt manual-copy recovery,
  native keyboard disclosure, completion auto-collapse, retry/recovery,
  optional-history skip, workspace handoff, sign-out, and return to setup.
- Prompt-preview text matches the actual copy payload in all four stages.
  Snippet fallback selects the exact multiline command. No horizontal overflow
  was observed in the reviewed layouts, and no JavaScript console errors were
  observed on the completed paths.

## Corrections

- Unified history import before and after activation around the interactive
  `opencrawl collect backfill` command; removed the obsolete dropdown/prompt flow.
- Consolidated duplicated help into checklist instructions and placed recording
  troubleshooting beneath the first-recording check.
- Kept clipboard-error feedback compact and persistent, with manual-copy
  instructions outside the command bar and stable success/error control widths.
- Restored focus when completion collapses an active disclosure and announced
  the actual current heading when state or error recovery changes the screen.
- Extended compact-height spacing through 800px to fit the longest tablet
  landscape screen. Added preview-only loading, importing, and clipboard-failure
  controls so these paths remain reviewable.

Validation: `npm test` — 80 passed, 4 existing skips, 0 failed. A regression test
also checks that concurrent status consumers retain the loading fixture.

The CLI picker release and hosted adapter requirements remain separate from
this UI pass; see [the preview contract](frontend-preview.md) and `DESIGN.md`.

## Manual progression follow-up

The original checklist now stays visible through completion. All required
checks reveal Next, which opens Sources only when clicked; optional history
keeps its actual state. Browser review confirmed this at desktop and mobile
sizes, including refresh on the completed checklist and navigation to Sources.
Intermediate fixtures keep Next hidden. `npm test`: 80 passed, 4 skipped.

Completion keeps the original setup description and copy/reveal control. Next
now sits outside the panel, aligned with its right edge and separated by 24px.
The optional history row reserves its status height, so the panel and setup
controls retain identical bounds between fresh and completed fixtures. Browser
review confirmed no page overflow at 1280×720, 1133×744, 744×1133 and 390×844;
copy feedback and manual navigation to Sources work after completion. The
mechanical design scan returned no findings. Tests: 80 passed, 4 skipped.

Next uses an 8px label-to-arrow gap with the group centered in its 104×44px
button. Shared primary controls use the OC mark's coral/red and cobalt/blue
layers, appearing only on hover over 160ms; resting controls have no layers. Browser review confirmed
the layers on standalone controls and around the outside of the split control
when either half is hovered, with an unchanged internal divider. The narrower
Next grouping remains intact. Tests: 80 passed, 4 skipped.

## Sources onboarding rebuild

Agent setup and Sources now use the same `renderOnboardingShell` component and
onboarding document header. Browser measurements confirmed identical logo,
Sign out, heading and panel-top positions and the same panel width. The Sources
content is reduced to one search field and compact connector rows; Back and
conditional Next sit outside the panel.

Reviewed initial, connected, filtered, no-match, loading, catalog-error and
connection-error/retry states in localhost. Next remains hidden after a failed
connection, appears after server confirmation, stays available when filtering
out the connected source, and survives refresh. Back retains agent receipts;
both Next transitions work. Search and Connect work by keyboard. Desktop,
1133×744 tablet and 390×844 phone views fit without page overflow. The tailnet
screen was refreshed to the new unconnected Sources state for iteration.

`npm test`: 82 passed, 4 existing skips, 0 failed. New checks cover the source
gate, failed/retried connections, idempotent Connect and source removal. The
mechanical design scan returned no findings. Connections remain simulations;
this review does not verify OAuth, indexing or production source receipts.

Connector logos were restored from the existing product SVGs. The row now has
a fixed logo/name grid and a fixed 128×44px action area in both Connect and
Connected states. Browser measurements confirmed identical column positions
and vertical centers across all rows, with all four local logos loaded.
Reviewed default, connected and inline-error states plus tablet/phone layouts.
The error expands beneath the name without moving the main row upward.
`npm test`: 82 passed, 4 skipped. Mechanical scan: no findings.

All four connector icons now render as 32px rounded squares with the same
corner geometry. Gmail and Slack keep their existing marks on white square
backgrounds; Granola and GitHub keep their existing backgrounds. Confirmed the
shared silhouette and logo loading visually on desktop and mobile.

The catalog was refreshed from a fresh fetch of hosted main `7c8261e9d`.
`app/integrations/providers.mjs` hides Gmail and defines Google Drive, Slack,
Granola, Circleback, Notion and GitHub. The preview now matches those six and
rejects the old Gmail connection route. Icons reuse that revision's assets,
with the same rounded-square treatment. Search names the catalog size and
covers every provider; the list scrolls inside a four-row area. Browser review
confirmed Gmail has no result, Drive connects and unlocks Next, Notion and
Circleback are searchable, and keyboard navigation reaches the lower rows.
Desktop and phone layouts remain compact, with all six icons loaded and no
console errors. Tests: 82 passed, 4 skipped. This sync updates the private
preview catalog; connection operations remain simulated.

Sources now uses full-tile connector buttons: a three-column desktop grid and
two-column phone grid. All six are visible without an internal scroller. Each
tile keeps its logo, name and status aligned across Connect/Connected states;
the whole surface accepts click, logo tap and keyboard activation. Reviewed
filtered, connected, failure/retry and mobile states. Next stays hidden after
failure and appears after confirmation. The 390×844 layout fits without page
overflow. Tests: 82 passed, 4 skipped; mechanical scan: no findings.


Tiles now use a shorter horizontal layout: 64px high in two desktop columns,
56px high in one phone column. Each uses fixed 32px logo and 20px action
columns with the name between them. The plus becomes the existing green
circled check after connection; accessible labels retain the full action and
status. Browser measurements confirmed matching vertical centers. Verified
plus clicks, keyboard focus, filtering, failed connection/retry and the Next
gate. The 390×844 layout has no page overflow. Tests: 82 passed, 4 skipped.

Fixed the default-URL layout regression: the panel and left alignment no longer
depend on `?variant=panel`. Both the agent renderer and shared shell default to
the approved panel, and the preview route uses that default. Browser review at
the exact tailnet root URL confirmed the 640px panel and matching heading/copy
left edges. A regression test covers `/`, `/onboarding` and the legacy variant
URL in fresh and completed states. Tests: 83 passed, 4 skipped.


Connector search now appears only for catalogs of 15 or more. It starts hidden
to prevent a flash for smaller catalogs; hidden search leaves a 24px gap from
the description to the tiles and clears stale filters. Reviewed the real six-
connector tailnet view and temporary browser fixtures at 14 and 15: hidden at
14, visible at 15, and still visible when the 15-item catalog filters to one.
Tests: 83 passed, 4 skipped. The temporary fixture server was stopped.

## Optional invite step

Sources now leads to `/onboarding/invite` in the shared onboarding shell, with
the same header, panel and footer placement. The step has multi-email entry,
inline validation, Send invites and a visible Skip for now action. After an
accepted preview submission, a compact invitation list and Open workspace
appear without navigating automatically. The preview states explicitly say
that no emails were sent, including after refresh.

Browser review covered Sources → invites, malformed addresses, duplicate email
normalization, successful preparation, refresh persistence, a failed request
with retained input and retry, Back, Skip and Open workspace. Both completion
paths reach the workspace. The default and two-invitation states fit desktop,
1133×744 tablet and 390×844 phone views without page overflow. Console clean.
Tests: 86 passed, 4 existing skips. New checks cover optionality, receipt/source
gates, validation atomicity, duplicate retries, browser isolation and origin
checks. Actual invitation delivery and membership permissions remain hosted
adapter work; no real email or access grant occurred in this review.

### Invitation entry refinement

Replaced bulk textarea entry with individual teammate rows above a bottom email
field and Invite button. Browser review verified Enter submission, clearing and
returning focus to the field, duplicate feedback without duplicate rows, inline
validation, failed-request input preservation and successful retry. The input
and button share the same height and baseline at desktop and 390×844 phone
sizes, with no page overflow in the two-invitation state. Refresh preserves the
list and preview notice. The step remains optional. Tests: 86 passed, 4 existing
skips, 0 failures. Delivery remains simulated in the private preview.
