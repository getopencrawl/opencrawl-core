# Onboarding

Sign in to your OpenCrawl workspace. You can open Sessions, search workspace
content, and use the sidebar as soon as you join an organization. **Setup** stays
in the sidebar so you can return to it at any time.

## Check or repair this machine

Run `opencrawl doctor` after setup or an update. An agent can run `opencrawl doctor --json` with the same profile. Both commands apply saved choices and exit without prompting. Doctor supports local Claude Code, Codex, Cursor, and Antigravity plugins.

| Exit | Result | What to do |
| --- | --- | --- |
| 0 | `green` | Done. Recording apps include a verified session and time. An explicit recording opt-out can also be green. |
| 2 | `needs_human` | Show the person the requested sign-in, setup choice, or native hook review. |
| 3 | `needs_agent` | In the named app, emit the supplied marker when present and call the named MCP tool with its arguments. |
| 75 | `retry` | Wait `retryAfterSeconds` and rerun. |
| 1 | `blocked` | Read the reported incompatibility or failed check. |

JSON has top-level `schemaVersion`, `status`, `cliVersion`, `apps`, and `repairs`. Follow `nextAction.resume` with the same profile after completing an action. A recording app passes when a normal native session under the current installation challenge has delivered its marker and authenticated tool call, and the workspace can search and fetch the passage. Doctor renews the challenge after a relevant configuration change or 24 hours.

If a setup wizard holds the installation lock, doctor identifies its terminal when available. Finish setup, or cancel it with Ctrl+C, then rerun doctor. If Claude Code reports that OpenCrawl needs authentication, doctor prints the exact `claude mcp login` command for that connection. Approve OpenCrawl in your browser and rerun doctor. Agents can read the login command as an argument array in `nextAction.command`.

Automatic plugin updates follow the versions pinned by the CLI for apps selected during setup. Manual updates keep the accepted version. On supported Claude Code and Cursor installations, an atomic update retains a rollback copy until capture passes. A failed native installation check can restore that copy. An indexing delay leaves it in place. Updates that the host cannot activate safely stay pending. Codex continues to handle hook review in its native interface.

## Set up an agent on macOS or Linux

1. Install the [OpenCrawl CLI](https://github.com/getopencrawl/opencrawl-core/tree/main/cli#install) and run `opencrawl setup`.
2. Select **Cloud** or **Self-hosted**. For self-hosted, paste your workspace address. If sign-in is needed, follow the approval in your browser and return to the terminal.
3. Choose which agents should record new sessions. Use the arrow keys to move, Space to toggle items, and Enter to select a button. You can also choose **Do not record any sessions on this machine**.
4. Choose whether to import past sessions when setup offers history for a selected agent. On eligible Macs, setup also offers a background capture service. You can decline the background service to use recording hooks directly.
5. Follow the selected agent’s native connection prompts. After a new session is captured, the agent verifies its connection and whether that session can be found. Open **Setup** in the workspace to see which checks have finished.

Setup detects Claude Code, Codex, Cursor and Antigravity on macOS and on x64 or
ARM64 Linux systems with glibc. Claude Desktop’s Code tab and ChatGPT Desktop’s
Work sessions can use the desktop app’s own runtime. Open the app’s coding surface
once to initialize it. Unavailable integrations appear disabled below the recording
choices. Available history
and native approval steps vary by agent. Run `opencrawl setup` to choose again.
Setup reuses a valid sign-in for the workspace you select. To read the choices saved on this machine,
run `opencrawl setup status --local --json`.

## Automatic plugin updates

After choosing recording agents, check **Keep OpenCrawl plugins up to date (Recommended)**
to allow the selected apps to run hooks from future verified updates. The choice
starts unchecked. Run `opencrawl setup` again to change it.
Use `opencrawl setup updates` to check now or `opencrawl setup status --local --json`
to see which apps you selected.

On macOS and Linux, the native CLI can switch Claude Code's enabled local plugin
and Cursor's installed local plugin to the verified release bundled with the CLI's
release information. OpenCrawl keeps the current copy if the new release removes
an existing hook command, the local copy was edited, or the filesystem cannot
switch directories in one operation. A fresh session loads newly added hooks.

Codex requires review inside Codex for each changed installation. The Antigravity
installer briefly removes the active hook when replacing it. On these clients
the updater downloads the release and keeps the existing plugin running. Windows
also stages downloads. Devin Cloud follows the Git revision chosen in Devin.

## Run setup on someone's behalf

On a supported machine, run `opencrawl setup --json` to read the machine's plan.
Use the plan's `applyCommand` after the person has approved the recording and
history choices. It carries the API origin, selections and plan ID. The CLI
returns any remaining native approval or sign-in tasks. Inspect the workspace
with `opencrawl setup status --json`.

## Earlier guided web flow

Deployments serving the earlier guided flow use the following receipts and
navigation. The CLI-first workspace uses the optional Setup page described above.

The shared product renderers live in `src/onboarding*.mts`. The document frame,
icons, controls and browser JSON transport are reused across all three steps.
The hosted adapter supplies identity, scope, connector authorization, invitations,
billing admission and routing. It never copies the core product UI.

Copied commands and setup prompts prefer the native CLI installer on a person's
own machine. The shared `src/sessions/cli-installation.mts` supplies shell and
PowerShell commands; cloud bootstrap is pinned to the verified CLI version during
core publication. For cloud agents and locked-down sandboxes the setup prompt
prefers `npm install -g @getopencrawl/cli`, with the native installer as the
alternative. Installing the CLI is separate from
sign-in, recording consent, hook trust and proof of a stored session.

### Progress and gates

`createOnboardingStatus` persists individual receipts under the authenticated
user and tenant scope. Step one requires CLI authentication, a successful native
MCP `test_connection`, and an accepted batch containing a recorded message.
MCP initialization is not a connection-test receipt. Hook-only batches cannot
complete recording. For Grok Bot, whose sessions are built from hook payloads
and whose runtime may report only tool hooks, a recorded tool call counts as
well as a message; its lifecycle hooks alone do not. New CLI batches mark `captureMode` as `live` or `history`;
history updates a separate optional receipt and cannot unlock recording. Legacy
batches remain supported. Their original capture mode cannot be reconstructed.

CLI installation alone is not evidence of recorded messages, so the recording
parent remains pending until a live recording is stored. History shows Received
when a historical batch is accepted; this does not claim the entire import has
finished. The CLI's own final report describes full-import completion.

Step one never advances automatically. Its Next action opens Sources only after
the required receipts exist. Sources are optional: until a connection is
authorized the step offers a quiet Skip for now, and a confirmed connection turns
it into Next. Indexing may continue in the background. Starting OAuth is not a
connection. If the catalog fails to load, Try again and Skip for now both remain.
The provider callback returns to Sources without advancing the onboarding step.
The catalog comes from the current hosted service, not a copied provider list.
Search appears only for catalogs of at least fifteen connectors.

The final teammate step is optional. Admins can invite one email at a time;
ordinary members can continue without seeing or sending invitations. WorkOS owns
invitation delivery and the existing hosted service always assigns member access.
The browser receives email-only invitation DTOs, never tokens or membership roles.

Both Skip for now and Open workspace POST to the authenticated finish endpoint.
The adapter rechecks the agent gate before saving a durable completed receipt;
finishing never requires a connected source. It then opens `/`, the actual
workspace home backed by authorized search. Completion is idempotent and scoped.
Disconnecting sources later does not relock an already completed workspace.
Existing receipts are retained; absent new milestones are shown rather than
inferred from clicks or stored browser state.

### Presentation and recovery

All steps share the boxed, left-aligned shell and bounded header with Sign out.
Forward navigation sits outside the panel at the right; Back stays quiet with
matching arrow insets. The primary button's brand layers appear only on hover.
The setup prompt remains unchanged while required receipts arrive. Pending checks
do not open disclosures, move the viewport, or replace it with MCP setup/test
prompts. The expanded prompt and manual-copy fallback remain available until setup
completes. Checklist disclosures close when their receipt first becomes complete.
Prompt and snippet copy feedback clears after 1.5 seconds; disclosure changes are instant.
Clipboard failures retain a usable manual-copy path.
Replicas enrollment stays in workspace Agent setup for administrators; the focused
onboarding flow does not offer that separate installation action. Existing shared
readiness still opens the workspace and offers personal-computer setup.

The release contains no preview controls, simulated APIs, variant switches or
mock workspace. Hosted route tests use synthetic identity/provider adapters;
real authentication, provider authorization, delivery and retrieval remain live
release acceptance checks. Core and CLI checks run independently without hosted
credentials. Publish immutable core and CLI versions, then advance the hosted
package, integrity lock and Git source pin together before deployment.

## Import the last N local sessions

After enrollment, agents can preview and import a bounded slice of history.
For the five most recently active sessions in the current project, run:

```sh
opencrawl history list --project . --limit 5 --json
opencrawl history import --plan-id <data.planId> --yes --json
```

The list returns native session IDs, clients, working directories, activity times
and source byte counts. Omit `--project` for machine-wide history or add
`--harness codex` to select one client. The limit spans all selected clients.
A plan fixes the destination, selected files and byte bounds. Newer sessions
and subsequent appends stay outside it. An interrupted import can reuse its
plan ID. Existing capture exclusions apply. Future recording is independent.

## Agent workspace permissions

All four personal setup plugins connect to workspace search, the board and
shared files when the workspace offers them. Each can suggest relevant history
with native hooks. See the [per-agent delivery details](../cli/docs/context-checks.md#native-delivery).

When you select Claude Code or Codex, setup adds a workspace-sharing directive to
the client's global `CLAUDE.md` or `AGENTS.md` (or its active Codex override).
For Claude Code it also adds user permission rules for `opencrawl files`,
`board`, `search`, `browse`, and `fetch` and the installed plugin's board and search tools.
Auto mode receives the configured workspace address for shared-file Git handoffs
and board listeners. You can edit or remove the entries. Rerunning setup for
that profile preserves your choices. Claude's ask, deny, and managed policies
continue to apply.
