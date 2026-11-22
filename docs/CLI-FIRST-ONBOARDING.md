# CLI-first onboarding

Interactive setup on macOS connects a workspace and installs recording for the selected agents.

## Human path

1. Run `opencrawl setup` in a terminal. The entire interactive setup uses one
   Ink TUI: workspace input, browser approval guidance, installation, history,
   verification, errors and completion share its frame and keyboard controls.
   The welcome screen explains recording and links to the OpenCrawl Cloud privacy notice.
   Choose Cloud or Self-hosted unless a destination is explicitly
   supplied. Cloud uses `https://app.getopencrawl.com`; only Self-hosted asks
   for a workspace address. Back returns to the hosting choice. An explicit `--api` or `OPENCRAWL_API_URL` skips both questions. Complete browser sign-in if needed;
   the TUI continues when approval arrives.
   Footer hints follow the focused control: arrows navigate choices or buttons,
   Left/Right edits the address, Space toggles checkboxes, and Enter activates
   the current action. Busy screens show Escape to cancel; completion shows
   only Enter to finish. Installation uses a moving violet trail while work
   runs, without claiming a measured percentage.
2. **Record new sessions.** Setup shows Claude Code, Codex, Antigravity (agy),
   and Cursor. A missing or outdated agent CLI is labeled with its command and required version. Move with the arrow keys and toggle checkboxes with Space. Move to the
   bottom buttons and press Enter to activate one. Selecting an agent installs its integration and enables capture.
   Compatible detected agents start selected on each interactive run. Selecting an agent with a missing prerequisite leaves its installation pending. The final option
   is **Do not record any sessions on this machine**. You can still import past sessions with recording off.
   Eligible installations offer the background utility preselected.
3. **Import past sessions.** A separate screen lists supported local histories,
   including agents you left out of ongoing recording. Each one-time import starts unchecked. Choose histories to import or **Skip history import**.
   If no eligible history exists, setup continues without another question.
   Cursor history import is not currently supported.
4. Complete any required native agent sign-in/trust clicks. Claude-only setup
   can open Claude Code and continue verification automatically. Other selected
   agents receive their native setup handoff. `setup next --json` checks every
   selected agent; one verified agent cannot make the whole installation complete.

Run `opencrawl setup` again to choose the workspace, recording agents, background utility and history import afresh. A valid sign-in is reused.
Intact integrations show **Installed**. Setup reuses them and repairs missing
files or registrations for the selected agents. Closing the history screen
keeps the installed integrations. Skipping history preserves any existing
import and starts no new one.

## Agent path

Agents with approved inputs can apply them in one invocation:

```sh
opencrawl setup apply --api https://your-workspace.example --plugins claude-code,codex --forward claude-code,codex --history none --yes --json
```

Use the same harness IDs for `--plugins` and `--forward`. Installation implies
capture. Choose any supported history sources with `--history`. For a one-time
import with recording off, use `--plugins none --forward none --history codex`.
Use `none` for all three flags to skip both recording and import. Credentials missing from an
agent invocation produce a JSON action rather than an interactive questionnaire.

`setup --json` returns a plan and exact `applyCommand` without changing clients.
`setup next --json` returns the next remaining action. `setup wait --json` waits
for capture/indexing without another human reply and returns pending after a
bounded number of checks. It cannot create a missing native MCP receipt. JSON
mode never opens an agent. `setup --yes --json` preserves accepted choices and
reconciles activation. Plans bind to the authenticated workspace/person and the
history snapshot.

## Verification

A ready installation has native plugin activation and authenticated MCP evidence. When recording is enabled, the receiver must also find a new searchable native session with matching installation evidence. The setup page shows progress while the rest of the workspace stays accessible.
