# Disposable frontend preview

Run `node tools/frontend-preview.mjs` with Node 24 or later. It defaults to
`127.0.0.1:4310`. For the authorized tailnet preview use:

```sh
PREVIEW_HOST=100.121.97.107 PORT=4310 node tools/frontend-preview.mjs
```

Open `http://100.121.97.107:4310` from the tailnet. For clipboard access over the
existing HTTPS proxy, run on loopback with
`PREVIEW_ORIGIN=https://deepanshus-mac-mini.tailfb40c3.ts.net:8447` and open that
exact origin. The server accepts its explicit Host and Origin without trusting
forwarded headers. Run the server in the foreground and press Ctrl-C in that terminal to stop it
and discard all fixture state. Stop any task-owned HTTPS proxy separately; do
not stop an existing shared proxy. No package installation, production request, token, account sign-in,
or real integration is involved. This server is an unauthenticated visual demo,
not the self-hosted product runtime; do not expose it publicly or mount it in
production.

Open “Preview states” at the bottom left. Back/Next walk through fresh, CLI
signed in, MCP signed in, test passed, and complete fixtures. The selector can
jump directly to any state or simulate a status error; “Show state” applies it.
The drawer stays open while progressing. “Loading status” reloads into a brief
loading state, “History importing” exposes optional import progress, and
“Simulate clipboard failure” exercises both actual copy fallback paths. This
checkbox changes only this preview document’s clipboard API and resets on reload. CLI and MCP sign-in can be simulated
independently. “MCP signed in first” exercises the out-of-order CLI approval
heading. Next follows the ordinary CLI-first path. Completed test receipts skip
the fallback agent prompt; missing recording receipts update the instruction
to the human new-session handoff. The full checklist stays visible. All required
checks passed turns those rows green and reveals Next to Sources outside the
panel at its right edge. The original setup description and copy control remain
in place. Completion never
replaces the checklist with a ready screen or navigates automatically. The prompt preview displays the real setup prompt pointing to
app.getopencrawl.com; copying or revealing it does not execute setup. Status and
workspace operations in this preview still use only fixtures.
The agent gate requires CLI, MCP test, and first-session receipts. Sources opens
after those three exist; workspace pages and APIs additionally require a source.
Search returns labeled local examples; Google Drive, Slack, Granola, Circleback, Notion, and GitHub Connect
buttons only add an in-memory fixture connection. Usage
counts those local interactions. A scenario change resets search/source counts.

Fixtures belong to a random HttpOnly, SameSite=Strict browser cookie and expire
after one hour idle. The server caps sessions at 128, bodies at 4 KiB, and
connections at 64. API writes require JSON; the sign-out form also accepts form encoding. All
writes require the exact same Origin and an allowed
Host/port; static files use an explicit allowlist. These controls do not turn the
demo into an authenticated service.

Run `node --test test/frontend-preview.test.mjs` for route, isolation, and request
boundary checks; run `npm test` for the repository checks.

## Current iteration host

This iteration runs in the managed `guided-onboarding` checkout on branch
`codex/guided-onboarding`. The private HTTPS address is
`https://deepanshus-mac-mini.tailfb40c3.ts.net:8447/`; Tailscale Serve proxies to
loopback port 4310. The background process PID and log are in the ignored
`.preview/server.pid` and `.preview/server.log`. Verify the PID's command before
stopping it. Restart the Node process after server or renderer changes; CSS and
browser JavaScript update on refresh. Leave the process and dedicated proxy
running while iterating.

The source-disconnect dialog explains removal and offers Cancel before the
simulated operation. The preview does not delete real imported data.

## Recording and optional history

`/onboarding?variant=panel` keeps the setup review accessible after required setup
is complete. `/` also retains the checklist after completion; only the user’s
Next click navigates to Sources. Sources links back to the
setup page for optional history import. The preview can simulate history imported
before a new recording, as well as completed or skipped history after activation.
Only the independent recording receipt satisfies the recording gate. The preview
skip endpoint saves a browser-scoped fixture preference; it never starts an import.
Live runtime adapters must implement scoped history receipts and skip storage.

The onboarding header restores the existing Sign out POST control. In this
disposable preview it clears only the current browser fixture and shows an
explicit preview-session-ended page. Hosted adapters supply their own logout
URL to `renderDocument`; no WorkOS session is involved in this preview.


Sources is now the second onboarding step at `/integrations`. It reuses the
agent step's panel/footer shell and onboarding header, with searchable connector tiles
and Back/Next outside the panel. Next appears after at least one confirmed
source connection; Search/Usage routes and APIs enforce that requirement too.
Connections remain browser-local simulations, not OAuth or indexing receipts.
The preview menu includes Choose a source, Loading connectors, Connectors
unavailable, One source connected and Connection fails once. The last fixture
fails the first Connect attempt so the inline retry state can be reviewed.


The approved boxed, left-aligned agent screen is the default at both `/` and
`/onboarding`. No `variant` parameter is required; old `?variant=panel` links
continue to show the same layout.


Sources Next opens the optional teammate-invite step at `/onboarding/invite`.
Its shared onboarding frame lists teammates above a single email field and
Invite button, with Back and Skip for now; accepted preview invitations reveal
Open workspace. Enter submits one address and returns focus to the cleared field. The invitation API
validates and deduplicates up to ten addresses per request and stores records
only in the browser fixture. No email is sent and no member gains access.
Preview states include Invite teammates, Invitations prepared and Invitations
fail once. Real sending and inviter permissions belong to the hosted adapter.
