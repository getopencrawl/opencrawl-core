# Onboarding release QA

Validate the CLI bootloader, the native agent handoff and permanent Setup page
against [the behavior contract](onboarding.md). A passing build, installed plugin,
saved token or synthetic transcript is not a completed native onboarding run.

## Automated coverage

Core checks cover user/tenant/installation isolation, immutable capture and
indexing handoff, authorized search/fetch proof, native MCP call/result
correlation, expired proofs and search-only clients. MCP `installation_status`
uses the existing scoped verification service. Capture-only credentials, another
user or installation, another client, wrong nonces, history and synthetic shell
responses must not manufacture native verification.

CLI checks cover authentication before mutation, independent plugin/recording
and history choices, cancellation, saved opt-outs, bounded history consent and
idempotent resume. Plugin fixtures verify deployment/profile binding, bundled
startup and capture hooks for Claude Code, Codex, Cursor and Antigravity, and
prepared-versus-activated reporting. Migration cases preserve foreign hooks,
trust indices, queues and customized runners. Native package checks cover the
managed invocation and native/JavaScript compatibility on supported platforms.

Offline `setup status --local --json` tests must prove zero network, credential
refresh, child-process, history-worker or file-write effects. Exercise malformed
flags and saved files, missing state, mismatched API/owner/installation, global
hook ownership and disabled recording. Its output must state local-only
freshness and `serverChecked: false`; it must not claim current authentication.

Browser checks cover Setup as the first persistent sidebar item, access to other
workspace pages while setup is empty or pending, legacy route aliases, per-client
status and history progress, and adding another installation after first win.
Verify the guarded installer runs setup once only after a successful install.
An incomplete paired command override fails closed. Keep the handoff stable,
selectable on copy failure, keyboard-accessible and usable at narrow widths.
An absent CLI activation observation must not hide native MCP/search evidence.
Legacy focused components and receipt APIs retain compatibility coverage;
three-step completion is not a current navigation gate.

## Actual user journeys

The first release targets Claude Code and Codex client enrollment on macOS.
Verify those native journeys against the paired deployment and record the exact
source, platform and client combinations exercised. Linux client onboarding and
the remaining native clients are later acceptance work; do not report them as
complete from macOS evidence. Cover both Cloud and self-hosted authentication
as those release paths become available. Use normal installers,
sign-in, native plugin loading, trust and MCP controls. Preserve existing user
configuration and consent. Do not copy credentials, approve trust on the user's
behalf, change sandbox policy or use seeded identities as substitutes.

For self-hosting, complete normal first-admin server provisioning separately
before testing client enrollment. Cloud must use an admitted workspace through
its real identity adapter. CLI sign-in must finish before the plugin/history
choices. A required native security or identity action is an explicit pending
human step, not an automated acceptance result.

Verify these scenarios in the real journey:

- Start with no CLI profile; then repeat/resume with the same installation and
  add another client. Existing off choices, auth, history and unrelated native
  hooks/trust survive. Native installation policy or disabled plugins produce
  a recoverable task, not a fabricated installed result.
- Confirm the plugin/recording dependency and a search-only plugin. Choose history
  independently, including none and a real pre-existing session. The history
  screen states its benefit once; the worker continues in the background.
- Continue in the coding agent's conversation. Present one human action at a
  time. A required native reload resumes saved progress. Do not repeat the
  selection questionnaire or switch to a “test MCP” prompt.
- With ordinary shell network access restricted, obtain the exact local binding
  through `setup status --local --json`, then use native `installation_status`
  and `verify_installation`. Unavailable shell escalation does not justify
  changing permissions or repeating sign-in.
- For each recording client, capture a genuine new marker message and the native
  verification call/result. Confirm the same authorized passage is searched and
  fetched. Another harness, historical data or shell-printed MCP response cannot
  supply this evidence.
- For a search-only client, complete authenticated native transport without
  requiring a new capture. If local and server recording choices disagree,
  preserve the local opt-out and leave verification pending until ordinary
  authorized resume reconciles them.
- Open Sessions, Integrations and Team before setup finishes. Return to Setup
  after the first searchable session and add or retry another installation.
  Sources and invitations are optional workspace actions, not onboarding gates.

## Evidence and terminal states

Record source/native versions, deployment type, client/version, installation ID,
normal actions, observed outcomes and remaining human steps without credentials
or unrelated conversation content. Distinguish local configuration, authenticated
transport, durable capture, indexing and search/fetch proof.

| Case | Required evidence |
| --- | --- |
| Recording client complete | `proof.state=verified` and `mcp.state=authenticated` for the same installation and client. |
| Search-only client transport complete | `forward=false`, `proof.state=not_selected`, `mcp.state=observed`, and the native `authenticated_transport_observed` result. No capture claim. |
| Plugin prepared | Native activation remains pending; directory creation or registration alone is insufficient. |
| First win | A genuine new session was captured and retrieved. Other clients and history may still be pending. |
| History worker complete | The approved snapshot reports processing complete; do not infer that all imported records are indexed. |
| Capture/index/auth/trust pending | Preserve progress, name the next supported action and leave acceptance incomplete. |

For a recording client, a searchable marker with only `mcp.state=observed` is
still missing native call/result correlation. For search-only clients, waiting
for capture or `mcp.state=authenticated` would be an error. Keep history failure,
plugin activation and server verification separate in the UI and receipts.

Check pending verification at most twice per interaction, at least 15 seconds
apart, then continue later. Record failures and user-required steps honestly.
Automated and isolated fixtures cannot replace these actual native journeys or
remaining user-required steps. Keep release acceptance incomplete until its
required real runs and outstanding correctness gates are satisfied.
