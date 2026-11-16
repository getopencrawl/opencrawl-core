# CLI onboarding and permanent Setup

The first win is one real new agent session becoming searchable. The CLI is the
bootloader: it authenticates, installs the chosen plugins, saves recording and
history choices, and runs approved history imports in the background. The agent
is the interface for human steps such as native hook trust and MCP sign-in.
Setup is a permanent first sidebar item at `/setup`, not an admission gate.
An authenticated, admitted user can use the rest of the workspace while setup
is incomplete and return later to add another machine or client.

Core owns this flow, its React UI, portable CLI and evidence contracts. The
hosted shell supplies tenant selection, provisioning and hosted admission;
self-host uses the core single-tenant adapters. Authentication and resource
permissions still apply to every route. Nonblocking setup does not mean
unauthenticated access.

## Launch availability

New setup currently offers Claude Code, Codex, and Cursor on macOS. Other clients and
client operating systems are deferred; their adapters and existing installations
remain supported. Saved deferred selections may continue or be turned off, but
cannot be newly enabled. A legacy installation containing deferred clients stops
before changing configuration. This client availability is separate from the
operating system running a self-hosted server.

## Cloud and self-hosted authentication

**Cloud:** run `opencrawl setup` against the hosted deployment, or use the
installer command on its Setup page. The CLI completes browser device sign-in
before presenting client choices. The hosted adapter uses WorkOS and resolves
the user's admitted workspace. A remaining account or workspace requirement is
reported as such; installation never substitutes for membership or admission.
Each agent's MCP connection subsequently authenticates through its native flow.
CLI authentication does not authenticate MCP on its behalf.

**Self-hosted:** the operator first starts the supported distribution and uses
its private first-admin setup link. That one-time server provisioning step is
separate from connecting a client machine. Users then run
`opencrawl setup --api https://your-opencrawl.example`; device sign-in and MCP
consent use that deployment's Better Auth identity and local accounts. Existing
workspaces admit additional users through their invitations. No OpenCrawl-hosted
account or WorkOS account is required. See [self-host operation](self-host.md).

Both flows use the same subsequent choices and verification. The copied command
is bound to the selected deployment. Native CLI installation is preferred; npm
remains an alternative. Installation failure must stop before setup executes.

## The bootloader flow

1. **Authenticate the CLI.** Reuse a valid saved sign-in. Complete the normal
   browser handoff when required, then establish the current API, owner and
   installation binding before changing clients.
2. **Choose plugins and future recording.** Setup offers native
   Claude Code, Codex, and Cursor plugins on macOS. Detected offered clients
   start selected; saved off choices remain off. Recording requires that client's
   plugin: turning its plugin off also turns recording off, and turning recording
   on selects the plugin. A plugin may remain installed for search with recording
   off. The CLI prepares the collector and installs the selected plugins.
3. **Choose historical imports separately.** Show this benefit in one line:
   “Import past sessions so your agents can find previous decisions, fixes, and
   context.” Available supported histories start selected, subject to saved
   choices; importing none is valid. History is independent of plugin and future
   recording choices. The current selector offers available Claude Code and Codex
   histories on macOS. Save the approved file snapshot and start its
   background worker; do not wait for the archive to finish.
4. **Continue in the coding agent.** The handoff reuses the exact installed CLI
   invocation and saved choices. Explain only the next required native trust,
   reload or MCP sign-in action. Preserve the conversation when the harness
   permits it; a required reload or new conversation resumes saved progress.
5. **Verify the selected clients.** Each plugin-selected client completes its own
   native MCP exchange. Only clients with future recording enabled need a new
   captured session. History-only clients continue importing without a capture
   verification requirement. One primary agent may coordinate these steps but
   cannot supply another client's native tool evidence.

Native plugin bundles contain both startup and capture hooks. Setup
offers the Claude Code, Codex, and Cursor bundles. The CLI owns collector
configuration, queues and history workers;
it does not install global client hook or startup-skill files for this flow.
Capture still requires the saved recording choice. Plugin identities are scoped
to the deployment and their installation receipts bind the CLI profile, preserving
another profile's or destination's plugin.

Cursor's local plugin includes MCP, startup and capture hooks. Setup preserves
manually configured MCP connections and installs the deployment-specific plugin
alongside them. Cursor historical imports are not offered; new-session recording
starts at the saved consent boundary.

A bundle marked `prepared` has not yet demonstrated native hook activation.
Native loading, policy or trust can still require attention. In particular,
writing a Cursor local plugin directory is not proof that the native client
loaded it. Disabled or foreign installations remain intact. `setup resume`
reconciles native registration and current bundle contents using saved choices;
it does not repeat the questionnaire or broaden the approved history snapshot.

## Local state and native verification

`opencrawl setup status --local --json` reads the exact local capture/setup
binding and returns `installationId`, `scope`, `savedSelections` and effective
`selections`. It performs no network request, token refresh, child-process launch
or write. `freshness: "local-only"`, `scopeSource: "saved-capture-config"` and
`serverChecked: false` explicitly exclude fresh authentication or server proof.
Missing, malformed or mismatched state fails without resetting setup or sign-in.
Use the command prefix supplied by the installed guide rather than assuming a
different CLI on `PATH` uses the same profile.

The agent then calls this deployment's native MCP `installation_status` with the
local installation ID and its own client ID. This tool issues or checks the
server-owned proof through the existing authorized verification operation; it
does not change the user's choices. Compare server recording selection with the
local effective selection. If they differ, preserve local opt-outs, leave
verification pending and reconcile with ordinary authorized `setup resume`
when available. Do not follow a stale server capture task or claim completion.

Call native `verify_installation` with the same installation/client and returned
`proof.id` as `proofId`. With recording enabled, include `proof.marker` once in a
normal assistant message and let the client's trusted plugin hooks capture that
message and its native tool call/result. Never synthesize a transcript, seed a
batch, or replace the native MCP call with a shell request. Check
`installation_status` again for capture, authorized search and fetch evidence.

| Evidence | Meaning |
| --- | --- |
| `prepared` plugin result | Bundle prepared; native activation remains unobserved. |
| `installed` or `unchanged` plugin result | Matching native activation was observed locally; this alone proves neither MCP authentication nor search. |
| `proof.state=waiting_capture` | The selected client's fresh marker message has not been observed. |
| `proof.state=waiting_index` | Capture exists; authorized search and fetch have not yet confirmed the matching passage. |
| `proof.state=verified` | The matching user's installation, harness, session and event were found and fetched. |
| `mcp.state=observed` | The authenticated MCP exchange occurred; for recording clients, native call/result correlation is still missing. |
| `mcp.state=authenticated` | The native verification call/result was correlated with this client's captured session. |
| `firstWin` | The first new session was captured and retrieved; other clients and imports may remain incomplete. |

For `forward=true`, client verification completes only when
`proof.state=verified` **and** `mcp.state=authenticated`. For `forward=false`, the
native tool returns `authenticated_transport_observed`; status with
`proof.state=not_selected` and `mcp.state=observed` is sufficient for search-only
transport proof. Do not enable capture or wait for `authenticated` in that case.
These outcomes are distinct from plugin activation and historical import status.

Check at most twice after an action, at least 15 seconds apart. If capture or
indexing is pending, retain progress and continue on the next interaction.
Do not replace the handoff with a separate “test MCP” prompt. A connection test,
installed configuration, history upload, CLI login or another client's receipt
cannot establish this client's new-session verification.

Native MCP authentication and transport are separate from shell network access.
Respect the harness's declared permissions; use its normal approval mechanism
when one is available and stop a denied command. Do not change sandbox policy,
copy CLI credentials into plugins, or ask for another sign-in because a shell
network request failed. Online `setup status`, `setup resume` and
`verify-installation --client CLIENT` remain available with normally authorized
shell access. The native MCP path does not require that access.

## The Setup page and recovery

`web-v2/src/application/setup.tsx` uses `Page`, `Section`, `CopyField` and status
rows inside `AppShell`. It offers installation/setup commands, a stable agent
handoff, per-machine client status and separate history progress. It remains
available after the first win and while new clients are added. A missing CLI
activation observation stays visible separately from authenticated MCP/search
evidence; successful proof must not be hidden behind a stale installation label.

History completion means the approved local worker has finished processing its
snapshot. It does not establish that every record is already searchable. Upload
acceptance, indexing and first-session verification remain separate facts.
Failures retain the queue, saved selections and progress for retry.

Integrations and Team are ordinary workspace destinations. Neither connecting a
source nor inviting a teammate is required to use the workspace or reach the
first searchable session. The Setup page does not offer Replicas enrollment.
Admin-only source and team operations retain their existing authorization.

Legacy `collect install` remains supported. Migrating its global hooks preserves
foreign profiles, queued data and native trust. Only verified same-profile owned
runners may be refreshed; unsafe or unknown definitions block migration rather
than silently disabling recording. Native plugin preparation and activation are
separate stages, so migration must not promise uninterrupted capture while the
client still needs to load or trust the new plugin.

## Compatibility and owning sources

The older focused onboarding components, `createOnboardingStatus` receipts and
`/api/onboarding/*` operations remain compatibility surfaces. Their CLI/MCP/live
and historical observations are retained; they no longer define workspace
admission or a mandatory three-step funnel. Legacy `/onboarding` and `/agent-setup`
links open Setup, `/onboarding/sources` opens Integrations, and
`/onboarding/invite` opens Team in Settings. `/settings` opens its Team section. Do not remove stored receipts or infer new
milestones from a legacy completed flag.

Current behavior lives in `cli/src/setup/`, `src/setup/`, `src/mcp/server.mts`,
`web-v2/src/application/setup.tsx` and the shared route registry in
`web-v2/src/application/app.tsx`. See [onboarding QA](onboarding-qa.md) for the
distinction between automated checks and actual native acceptance.
