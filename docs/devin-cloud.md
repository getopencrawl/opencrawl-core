# Devin Cloud adapter status

An administrator can connect a Devin Cloud organization to an OpenCrawl
workspace using Devin's signed workload identity. Production checks verified
workspace search, board access and recording. With CLI 0.4.143 and a Devin
event grant in place before launch, an independent workspace reader also found
a fresh session's original user prompt, first shell command and its output.

## Administrator setup

1. Prepare the Ubuntu blueprint your team uses. Install OpenCrawl CLI 0.4.143
   or later and Devin’s official OIDC helper. Build and activate the snapshot.
   Use an updated CLI on the administrator’s machine as well.
2. Sign in to the target OpenCrawl workspace as an administrator. Run
   `opencrawl workload approve --provider devin` with the deployment URL and a
   private code file. Give the code to one Devin session through its encrypted
   **This session** secret and run `opencrawl workload connect --code-stdin` there.
   This binds the Devin organization to that workspace.
3. Choose whether to record when you generate the plugin. For recording, create
   a dedicated organization service user in Devin with access to session events.
   Supply its key to `opencrawl workload bundle --recording on --key-stdin` from
   a private file or secret manager (full command below). OpenCrawl verifies the
   credential with Devin and encrypts it in the workspace. Subsequent exports
   reuse it. Recording includes the opening prompt and early shell activity.
   For search and board access alone, use `--recording off`.
4. ZIP the contents of the export directory, including hidden files, with
   `.devin-plugin/plugin.json` at the expected path inside the archive. In
   **Customize → Plugins**, choose **Myself** or the organization, upload
   the ZIP and enable its MCP server.
5. Start a **fresh** Devin session. Verify workspace search. For recording, run
   a first command with an unpredictable output, then search from another
   OpenCrawl session for the original prompt, command and output under that
   Devin session ID. Include tool outputs when searching for the result.

For an explicitly single-session pilot, add `--one-session` to the recording
bundle command and bind the fresh session with `workload events --select-session`.
The pilot used Devin’s Member role, which can also manage organization sessions.
The service key stays on the receiver. Use `workload events --off` to erase it.

## Observed Cloud contract

On 2026-11-15, a personal plugin containing command hooks and one synthetic
skill was installed in Devin Cloud. The fresh session discovered and invoked
the skill. A downloaded artifact preserves all 18 hook receipts from two turns;
its SHA-256 is
`15c8914799131213705c82c1b92fdd003aa7e14c1aa0b5be0366b277331b43f3`.
`cli/test/fixtures/devin-cloud/hooks.json` contains those actual payloads with
the session ID and sender attributes replaced. It adds no missing events.

- The initial `SessionStart` arrived with the first `prompt_id` already set.
  That turn has no `UserPromptSubmit`, initial shell call or interim reply
  receipt. It has the final `message_user` tool pair and an empty `Stop`.
- The second turn has the prompt, both assistant deliveries, four shell calls
  and `Stop`. Repeated identical commands have distinct `tool_use_id` values.
- Both `Stop.last_assistant_message` values are empty. Delivered assistant text
  is in successful `PostToolUse` for `message_user`, in `tool_input.message`.
  `block_on_user` distinguishes interim and final deliveries in this probe.
- A shell command exiting 7 still has `tool_response.success: true`. The native
  output envelope ends in `Exit code: 7`. Transport success and command exit
  are separate facts.
- Long output has an `overflow_path` and an approximately 25 KB excerpt. The
  referenced native file contained all 5,001 lines, 138,920 bytes. The worker
  must recover that file before it disappears or report the incomplete capture.

Rebooting this test VM retained the existing files and session ID and emitted
`SessionStart` with `source: resume`. The next turn emitted prompt, shell,
assistant delivery and Stop receipts. This establishes a resume hook and file
persistence for this session; it does not prove supervision of an OpenCrawl
worker, VM replacement durability, or idle board push.

The resume artifact SHA-256 is
`0593ab7ae31f80ad8754349f56549d29210e84b72d6021188cd596a1a7ca247f`.
It records the unchanged first artifact digest and all eight resumed-turn
receipts. After export, the probe's hook configuration was saved as `{}`;
the editor confirmed no hooks for future sessions. The existing test session
keeps its start-time configuration. The installed synthetic skill and the
restorable plugin version history remain available.

## Shared worker interface

The portable adapter is `cli/src/capture/devin.ts`:

1. `devinSession(payload)` validates the native session ID. There is no invented
   anonymous identity or local transcript-path fallback.
2. A foreground hook hands off `{id, at, sequence, event}` durably and returns.
   Reserve three sequence positions per notice. Do not parse, redact, recover
   overflow, refresh credentials or upload on the foreground hook path.
3. In the shared worker, call `await devinOverflow(payload)`, then
   `devinEvents(notice, recovered)`. Overflow reads are bounded to 8 MiB and
   confined to regular `shell-*/content.txt` files in the runtime-owned native
   output pool. Arguments and arbitrary file references never cause reads.
4. Pass events through the common redaction, event identity, durable queue,
   retry and upload path. Retire the raw notice only after durable spooling.
   The adapter owns neither installation nor a second worker implementation.

Successful `message_user` produces the tool call/result evidence and an
assistant message. Failed or pending deliveries remain tool evidence. Missing
or unreadable overflow keeps the native excerpt with explicit output-capture
status; it is never described as complete. Shell exit extraction is limited
to the observed native envelope; other tool output is not interpreted as a
process status. Unknown events and empty replies remain hook evidence.

CLI setup and the shared runtime own enrollment, installation identity,
supervision and the durable spool. The Devin plugin owns its native skill,
hooks and MCP declaration. A session resume must reattach the same installation
and pending queue, with no repeated human login. Provider identity verification
and organization enrollment remain separate from this event decoder. Devin and
Replicas must keep distinct issuer verification, organization bindings and
workload owner namespaces; neither can inherit a human identity from requester
metadata.

The adapter now uses the shared daemon's `recordNativeDaemonHook` inbox and
`spoolDaemonEvent` conversion. Notices are bound to the authenticated API,
installation and owner before they enter the inbox. Pending identities cannot
record; a notice from a different installation remains held. Devin is an
event-only source: even a payload carrying a transcript path or a hook parent
PID cannot enroll a transcript watch or establish session lifetime. Each
delivery reserves three adjacent event sequence positions for its call, result
and assistant message. Overflow recovery runs in the worker, with enrollment
and forward consent checked again after the asynchronous read.

Isolated daemon tests cover native prompt/reply conversion, distinct repeated
executions, nonzero command exits, worker-only overflow recovery, byte-identical
upload retry after restart, installation changes, consent revocation and a
native CLI hook returning with stdin still open and the configuration lock
held. These tests use a synthetic receiver. They do not prove Cloud supervision,
production enrollment, first-turn completeness or native plugin acceptance.
The operational installation uses the shared plugin-owned setup path described
below. The generic capture installer alone is not a Devin Cloud onboarding
command.

The shared worker launch command now pins the deployment and carries the selected
workload mode and an absolute helper search path into a clean service process.
It does not copy tokens, provider credential-file locations or exchange overrides.
The worker obtains each identity through the helper, refreshes one rejected
identity check and keeps the renewed token paired with its verified owner.
Unknown modes, mixed human credentials and a changed owner fail closed while
queued data stays with its original installation. Local process tests cover
restart and upload with no saved credentials. They do not establish an installed
Cloud supervisor: the observed VM has no systemd user manager.

The Linux installer now uses the system manager for explicitly selected Devin
Cloud workload identity when the user manager is unavailable. It launches the
same foreground command in a transient service as the current non-root UID,
with private file permissions, no new privileges and crash restart. It persists
only the profile binding and supervision receipt. Setup verifies the live unit's
profile, UID and transient ownership before replacement; failed or unconfirmed
stops retain the receipt and queue. Hook recovery starts the same unit name
without replacing an existing service, and returns without waiting for the
manager. After a reboot removes the transient unit, the next native hook can
recreate it. This is hook-triggered recovery, not a boot-time service guarantee.
The shared plugin bootstrap must enroll the installation before hooks can
use this path. The live preview acceptance below separately exercises recovery
of the actual worker; the local adapter tests alone do not establish it.

A bounded live probe on 2026-11-16 confirmed that the VM's system manager
(systemd 249) can launch a transient process as UID 1000 and restart it after
SIGKILL. The replacement PID and restart count were observed; explicit cleanup
then returned `LoadState=not-found` and `ActiveState=inactive`. The probe ran
only the system's `sleep` executable and installed no persistent unit. Its
receipt SHA-256 is
`e6b1bb00e033a5fe097a8167b34abcb055328345474c964a61fdd8684ca13ef0`.
This establishes an available host mechanism, not supervision of the actual
OpenCrawl executable or recovery across VM reboot.

## Identity and enrollment implementation

Core includes a Devin verifier pinned to `https://app.devin.ai`, the expected
audience, signed organization/session claims and an authoritative organization
binding. Requester metadata never grants human resource ownership. The shared
connection registry preserves the existing Replicas record format and separates
records by provider. A live admin approval is short-lived, hashed at rest and
claimable by one verified workload; subsequent sessions use the approved
organization binding. Revocation is checked again at resource access.

Devin connections and single-use approval claims use scoped PostgreSQL tables.
The signed organization selects its approved workspace, and the signed session
selects its capture owner. The Devin and Replicas owner namespaces are separate.

The self-host adapter exposes the admin setup and signed-workload claim routes
and routes admitted identities through the common CLI, capture, MCP and board
operations. Tests use local Better Auth, PostgreSQL and synthetic signing keys,
with no hosted credentials, and cover fresh sessions, revocation, scope denial,
atomic installation writes and provider/installation namespace collisions.
`OPENCRAWL_AUTH=devin-cloud` selects the official `devin-oidc` token helper in
the CLI. Tokens remain in memory. A human administrator issues the one-time
code, and a signed Cloud session claims it. For a hosted installation, use
Devin's session-specific secret field and select **This session** before
submitting the code. [Devin session secrets](https://docs.devin.ai/product-guides/secrets#session-specific-secrets)

An admin with an existing CLI sign-in can issue the one-time code without a
provider-specific setup page:

```sh
opencrawl workload approve --provider devin --api https://opencrawl.example \
  --code-file /private/path/devin-approval
```

To disconnect, a currently signed-in workspace administrator can send an authenticated
`POST /api/cli/workloads/devin/disconnect` with `{"organizationId":"<Devin org_id>"}`.
The operation revokes the binding for future requests from that Devin organization.
Resuming enrollment requires a fresh administrator approval. Stored captures follow
the workspace's ordinary retention and deletion settings.

The command requires an explicit deployment and a new private file. It uses
the saved human sign-in, rechecks current admin membership and prints no code.
It is unavailable in workload identity mode. The runtime endpoint is
`POST /api/cli/workloads/devin/approval` with an empty JSON object; scope always
comes from the authenticated identity. Browser origins, query parameters,
workload tokens and caller-supplied workspace fields are rejected. Send only
the short-lived code through a secure channel to `workload connect --code-stdin`
in Devin Cloud, then remove the file. This entry point does not install the
plugin or establish capture parity.

The same Cloud VM supplied a real signed identity through Cognition's official
`setup-devin-oidc` helper. Signature verification against Devin's public JWKS,
issuer, audience, subject and expiry checks passed. The signed `org_id` used
`org-` followed by 32 lowercase hex characters; the signed `devin_id` exactly
matched the native hook's `session_id`, including its `devin-` prefix. Core
accepts that organization format and the UUID format documented by the provider;
Replicas retains its separate UUID validation. The observed token lasted only
60 seconds, so the CLI caches it with a proportional refresh margin and
coalesces both concurrent exchanges and delayed authentication failures.

The token stayed in memory and was neither printed nor saved. A token-free
verification receipt has SHA-256
`962f2a5a6edac301a4bb5abcc90ff974b1535a5e220ec2ca3e4506453c652478`.
Its `organization: false` field records the probe's original UUID-only shape
check; it is the evidence that prompted the validator correction. The official
installer was pinned to CognitionAI/actions commit
`c63a5d75c304ec2a2e5842ed844ff23763d28379` and verified with SHA-256
`441d3fc03bc69d5483e44a165593578c0b23175cea30286e64be6228a7e2cfa6`.
This proves provider identity issuance in that VM, not OpenCrawl enrollment,
native MCP authorization or capture upload.

## Fresh Cloud environment prerequisite

Install the native OpenCrawl CLI and Cognition's official OIDC helper in the
environment snapshot. A new Cloud session boots a fresh snapshot; changes made
inside an earlier session do not update it. Add these steps to the Linux
organization blueprint, preserving existing repository setup. This pinned
example was verified with CLI 0.4.143. Check the installer checksum for the
selected release whenever the pin changes.

```yaml
runs-on: linux
initialize:
  - name: Install Devin OIDC helper
    uses: github.com/CognitionAI/actions/setup-devin-oidc@c63a5d75c304ec2a2e5842ed844ff23763d28379
  - name: Install OpenCrawl CLI 0.4.143
    run: |
      set -eu
      test "$(id -un)" = ubuntu
      oc_blueprint_tmp=$(mktemp -d /tmp/opencrawl-blueprint.XXXXXX)
      trap 'rm -rf "$oc_blueprint_tmp"' EXIT HUP INT TERM
      curl -q --fail --silent --show-error --location --retry 3 --proto '=https' --proto-redir '=https' https://github.com/getopencrawl/opencrawl-core/releases/download/cli-v0.4.143/install.sh -o "$oc_blueprint_tmp/install.sh"
      printf '%s  %s\n' 2c5fe2b262a5c5a7345c4abfa21cd89dcc2577e8cbea63d3e0b78ebaf7591101 "$oc_blueprint_tmp/install.sh" | sha256sum -c -
      env -u OPENCRAWL_DOWNLOAD_BASE -u OPENCRAWL_AUTH -u OPENCRAWL_TOKEN -u OPENCRAWL_SESSIONS_TOKEN OPENCRAWL_NO_UPDATE=1 sh "$oc_blueprint_tmp/install.sh" 0.4.143
post-build:
  - name: Verify Devin OIDC helper
    run: test -x /usr/local/bin/devin-oidc
  - name: Verify native OpenCrawl CLI without Node
    run: |
      set -eu
      test -x /home/ubuntu/.local/bin/opencrawl
      oc_blueprint_version=$(env -u OPENCRAWL_AUTH -u OPENCRAWL_TOKEN -u OPENCRAWL_SESSIONS_TOKEN OPENCRAWL_NO_UPDATE=1 PATH=/nonexistent /home/ubuntu/.local/bin/opencrawl --version)
      test "$oc_blueprint_version" = 0.4.143
      env -u OPENCRAWL_AUTH -u OPENCRAWL_TOKEN -u OPENCRAWL_SESSIONS_TOKEN OPENCRAWL_NO_UPDATE=1 PATH=/nonexistent /home/ubuntu/.local/bin/opencrawl workload --help
```

This uses the official action and a checksum-verified published CLI installer.
It does not enroll an organization, store a token, configure a human credential,
or install the OpenCrawl plugin. `post-build` checks the executables without
minting an identity during snapshot creation. Verify the pinned action
in a successful snapshot build and then test renewal in a fresh Cloud session;
the earlier manual installation is not evidence for either step. A later fresh
Ubuntu session did verify two signed 60-second identities with the second issued
after the first expired. The helper matched the snapshot's recorded SHA-256 and
the native session ID matched both signatures. Tokens stayed in memory. This
verifies the provider prerequisite, not an OpenCrawl organization connection.

The combined Ubuntu snapshot subsequently built successfully and became active.
A fresh Cloud session inherited CLI 0.4.91 at
`/home/ubuntu/.local/bin/opencrawl`; version and workload help both exited zero
with `PATH=/nonexistent`. No per-session install was required. This release
predates the admin approval command described above: use native CLI 0.4.93 or
newer for the administrator step. Snapshot inheritance does not establish
OpenCrawl enrollment, native MCP, board access, capture or recovery.

Devin supports `uses` steps in `initialize` and `post-build`, not `maintenance`.
Maintenance instructions are shown to the agent at session start and are not
automatically executed. The organization blueprint applies the prerequisites across
repositories; keep project dependency installation in each repository blueprint.
See the [blueprint reference](https://docs.devin.ai/onboard-devin/environment/blueprint-reference)
and [environment lifecycle](https://docs.devin.ai/onboard-devin/environment/blueprints).

## CLI enrollment and startup

`opencrawl workload connect --code-stdin --api <origin> --json` claims the
administrator's one-time approval from the current Cloud session. The approval
arrives over stdin; the official provider helper obtains the identity token.
The command sends only the code in the JSON body, never a tenant, owner or
requester. It stores neither capability, refuses redirects, uses a bounded
response and retries a rejected identity once. A lost acknowledgement can be
retried with the same code and signed session. Another session cannot consume
that approval, although fresh sessions can use the connected organization.

Local tests exercise the real core verifier, enrollment registry and HTTP
handler with signed synthetic identities, plus the source and bundled CLI with
Node absent from PATH. They establish the command's protocol and credential
boundaries, not a production organization binding.

The shared `session start --harness devin` handler accepts native startup and
resume payloads, preserving the exact Cloud ID. With background startup enabled,
it requires this installation's saved Devin plugin selection and queues only
bounded startup metadata. It reports pending registration truthfully; an older
confirmed observation is not fresh authentication. The worker checks the current
API, installation, owner and selection, verifies the authenticated owner with the
same credential used for bootstrap, and stores a confirmed bound receipt only
after success. Recording may remain off. The legacy path still registers inline
and emits success only after confirmation. Both paths preserve the agent-chosen
profile across resume and never treat requester metadata as identity or read a
transcript path. Failure guidance does not request a human token or interactive
sign-in. Cloud delivers startup context after the hook completes; this still does
not prove first-turn capture or idle notification delivery.

### Cloud plugin bundle and shared setup

Prepare a deployment-bound bundle with an explicit recording choice:

```sh
opencrawl workload bundle --api https://opencrawl.example \
  --directory /absolute/export/opencrawl-devin \
  --command /home/ubuntu/.local/bin/opencrawl \
  --config-home /home/ubuntu/.config/opencrawl-cloud \
  --recording on --key-stdin --json < /private/path/devin-service-key
```

Omit `--key-stdin` and the redirection on subsequent exports to reuse the
workspace credential. For a workspace with several connected Devin organizations,
pass `--organization DEVIN_ORG`. Recording setup verifies the service account
and checks for Devin's session-events tool before writing the bundle.

Use `--recording off` for search and board access without new capture. The command
exports only public settings, shared skills, a Cloud-only manifest, native hooks
and a stdio MCP declaration. It does not install a plugin, include an enrollment
code, copy the exporting machine's owner or installation, or grant access. The
reviewed native executable at the specified Linux path and the official helper
must already be available in each fresh Cloud environment. Install the reviewed
bundle through Devin's supported plugin surface.

The native SessionStart hook runs `workload start`; do not invoke it manually or
manufacture native events. It verifies the exact session against the server's
authenticated workload owner, then uses the existing `setup apply`/`resume`
implementation, capture queue, supervisor and durable board bootstrap. There is
no parallel installer or worker. A new VM gets its own installation. Resume
preserves installation identity, pending data, recording opt-outs and deselected
plugins. The bundle rejects ambient human tokens, binds an absolute command and
profile, and verifies its complete file inventory before adoption. Owner changes
during setup fail before capture configuration is created or rebound.

Local regression tests exercise those paths with synthetic identity and HTTP
services, including interrupted publication and resume. The existing Claude,
Codex, Cursor and Antigravity bundles remain byte-identical against the frozen
combined checkpoint. This is source validation. Separate live acceptance below
establishes installation, native MCP, later capture/index/search and worker
crash recovery in the isolated preview. Cloud starts SessionStart in the
background. For sessions with an event grant, the worker can recover the
opening prompt and early shell receipts from Devin as described below.

## Native MCP transport

The CLI now provides `opencrawl mcp --api <origin>`, a stdio bridge to the
deployment's `/mcp` endpoint using the official MCP SDK transports. The plugin
can declare this native command with `OPENCRAWL_AUTH=devin-cloud`; there is no
static bearer token to copy into a connection form. The CLI obtains and renews
the provider identity on each HTTP exchange, reusing its in-memory token cache.
It refuses redirects and destination changes and retries authentication once.
Plugin-backed exchanges also recheck the bundle/profile binding before minting,
before sending and before releasing the HTTP response. A changed bundle requires
reconnecting the native MCP process.

The bridge forwards the server's protocol messages and tool definitions. It
does not recreate search or board tools. Stdio remains reserved for MCP, with
no opportunistic update, hook migration or skill refresh. In-flight requests,
input bytes and request lifetimes are bounded; cancellation and stdin closure
abort HTTP work. Protocol and transport errors never print HTTP error bodies.

Local acceptance covers legacy and 2026-07-28 protocol exchanges, token renewal,
real PostgreSQL board publication/retry/fetch/scope denial, and the bundled
application running over actual stdio with Node absent from PATH. This is not
native executable cross-platform release verification or Devin Cloud MCP proof.

For authenticated Devin workloads, workspace search derives a missing
`currentSession` from the runtime's verified native session identity. That
context participates in the query cursor and excludes only the same owner,
harness and session. Explicit inclusion still works; ordinary human identities
without native context retain the unavailable status. No requester metadata or
caller-supplied tenant/user field can establish the context's ownership.

## Board delivery while idle

The fresh Cloud test session reported no output/completion notification option
in its native `exec` schema. Its `get_output` and `wait` tools require an active
call. No background command was run for this check, so this is a native-agent
schema report, not an exercised proof that every possible push mechanism is
unavailable. A detached `board watch` process alone does not establish delivery
into an idle agent's context. Use the shared skill's work-boundary inbox fallback
until a supported notification path passes live acceptance.

Devin's [API index](https://docs.devin.ai/_llms/en/api.txt) documents that sending
a session message resumes a suspended session. The
[message endpoint](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages)
requires `ManageOrgSessions`. Its
[authentication model](https://docs.devin.ai/api-reference/authentication) uses
a service-user API key or a personal access token, separate from the workload
OIDC identity used by this adapter. A service-user integration is a possible
future delivery path, with a separate access grant and credential lifecycle;
it is not installed or covered by the existing OIDC bootstrap. Do not request
or store that credential in a plugin, VM snapshot, or captured chat.

The organization Hooks editor and session-preferences screen exposed no visible
blocking-startup control during inspection. The lifecycle documentation's
organization `blocking` exception remains an unverified configuration path;
do not add an undocumented JSON property or claim it closes the first-turn gap.

## Live preview acceptance, 2026-11-16

The temporary personal plugin used an isolated self-host deployment and synthetic
test content. These results do not establish hosted production behavior.

- The active Ubuntu snapshot supplied published native CLI 0.4.91 and the
  official OIDC helper. Version and workload help succeeded without Node on PATH.
  Real signed identity claimed one administrator approval; later fresh sessions
  needed no new login, approval code, manual startup or per-session installation.
- The 0.4.91 bundle discovered the shared skill and registered a named board
  profile. In fresh session `89724f4274a149cb950d123212431657`, installation
  `051926d5-cc93-444e-8ccd-84c6c6da91bc` reported native MCP authenticated at
  22:14:19.168 UTC and captured proof verified at 22:14:39.384 UTC. The actual
  native `installation_status` output was inspected independently. A concurrent
  marker delivery was rejected by the harness and then resent successfully.
- The proof verifier explicitly includes the current session only in its
  exact-provenance query. It recognizes Devin's `mcp_call_tool` wrapper only
  when a matching completed call/result pair names this OpenCrawl server and
  the exact verification arguments. Ordinary search still excludes the caller's
  session by default.
- Native board publication and an explicit work-boundary inbox read delivered
  a targeted mention once. The next inbox read had no duplicate. No automatic
  context delivery or idle notification was observed.
- Killing the real worker caused an automatic systemd restart in about eleven
  seconds, preserving installation identity and resuming uploads. The native
  Reboot virtual machine action also returned to uploads without manual recovery,
  but the unchanged boot ID means this does not prove a cold boot.
- Recording opt-out stopped the worker while preserving installation identity
  and pending data. An independently inspected receipt retained three queued
  events after stopping. MCP access continued in a tested stopped session.
- At 22:17:53.510 UTC, a bounded current-index query for the final session's user
  messages returned zero candidates without truncation or partial results. This
  corroborates the original raw-hook first-turn gap; later proof does not repair it.
- The isolated server was subsequently upgraded to merged revision
  `89ac8265cff3b591d0591dd8ff95ac450fe45d68`, whose tree exactly matches the
  tested PR. Public health and the image revision agreed, and the saved admin
  sign-in survived. Published native CLI 0.4.93 then passed `workload approve`
  without Node or a new login at 23:06:58 UTC. The code was saved in a mode-600
  file without being printed; the unused code file and temporary binary were
  removed. This check did not reactivate recording.

After acceptance, both temporary personal plugins were deactivated and capture
was stopped in all four verification VMs without purging pending data. Uploaded
plugin files and the working snapshot were retained.

The preview used an organization snapshot, workspace enrollment and a
deployment-bound plugin. Subsequent tested sessions inherited those settings.
Current recording setup includes authorization to capture the opening turn.

## Hosted production acceptance, 2026-11-19

The hosted rollout used core revision `01f57f6bdad3`. A separate Cloud
session claimed a temporary organization connection. A fresh Ubuntu session
using native CLI 0.4.139 then loaded the personal plugin exported by CLI
0.4.140. The earlier 0.4.91 snapshot predates the current bundle's
`plugin-hook` command. Update the snapshot before installing this bundle.

- Both shared skills loaded. Native MCP searched the approved workspace with
  the calling session excluded, registered board presence and read the inbox.
  The native installation receipt reached `mcp.state=authenticated` and
  `proof.state=verified`.
- An independent workspace search found the second-turn synthetic user message
  and assistant reply under the verified session, installation and workload
  owner. It also found call and result evidence for the MCP verification receipt.
  Exact, session-scoped searches returned zero candidates for the first user
  prompt and the marker requested for the first shell action. The run did not
  establish whether that command executed. All four marker queries had ready
  coverage.
- `collect uninstall` stopped background startup and preserved queued data.
  Native MCP search still worked with recording off. Subsequent user and
  assistant markers had zero matches in the same index. After the admin
  revoked the binding, the previously authenticated Cloud VM failed its
  read-only identity check.

## Hosted first-turn verification with CLI 0.4.143

The production test used a personal recording plugin on a fresh Ubuntu VM.
An administrator enabled a single-session event grant before launch and bound
it to the new session ID. The opening prompt requested a first shell command
that generated a timestamp. The assistant replied only with `done`.

Devin’s original events supplied the prompt, command, exit code and stdout.
A separate OpenCrawl workspace login found one user message, one tool call and
one tool result matching those events under the same installation and signed
workload owner. All three indexed identities matched the original provider
records, including their timestamps. The output also matched the native terminal
bytes and appeared nowhere in the opening prompt.

After recording stopped, a subsequent user message had zero matches in a
session-scoped search with ready coverage. The same VM received
`AUTH_FORBIDDEN` after the administrator disconnected the workspace, and
Devin rejected the revoked service key with HTTP 401.

Startup recovery covers the original user message and shell process receipts.
Devin labels its completion output as an excerpt. Other first-tool types, long
startup output, idle board delivery and replacement-VM durability still need
production verification.

Primary references, initially checked 2026-11-15; hooks and session APIs rechecked 2026-11-16:

- [Cloud plugins](https://docs.devin.ai/product-guides/plugins)
- [Lifecycle hooks](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks)
- [Plugin format](https://docs.devin.ai/cli/extensibility/plugins/overview)
- [Cloud MCP configuration](https://docs.devin.ai/work-with-devin/mcp)
- [Plugin MCP declarations](https://docs.devin.ai/product-guides/plugin-mcp-setups)
- [Session messages API](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages)
- [Devin MCP and organization service-user credentials](https://docs.devin.ai/work-with-devin/devin-mcp)
- [Cloud OIDC](https://docs.devin.ai/product-guides/oidc)
- [Official OIDC installer](https://github.com/CognitionAI/actions/tree/c63a5d75c304ec2a2e5842ed844ff23763d28379/setup-devin-oidc)

Cloud plugin hooks are documented as best effort. `SessionStart` runs in the
background after the agent and VM are available; Cloud does not emit
`SessionEnd`. The lifecycle reference also mentions an organization blocking
hook exception, but that exception has not been configured or verified here.
Do not infer Cloud guarantees from the local Devin CLI changelog.
