# Devin Cloud adapter status

This is an integration under development, not a supported installation or a
claim of capture parity. The native Cloud probe found a first-turn capture gap.
The production plugin, enrollment journey, worker supervision, native MCP and
board acceptance are separate, unfinished gates.

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
The shared plugin bootstrap must still enroll the installation before hooks can
use this path. Local adapter tests do not establish actual Cloud worker recovery.

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

The connection registry uses the current `ApplicationState` PostgreSQL port.
Devin and Replicas share the enrollment implementation but have separate
provider tables, approval codes and owner namespaces. Existing Replicas table
names, records and migration behavior stay intact. No Devin approval data has
been released on the earlier object-store implementation, so it has no legacy
data migration or object-store fallback.

The self-host adapter exposes the admin setup and signed-workload claim routes
and routes admitted identities through the common CLI, capture, MCP and board
operations. Tests use local Better Auth, PostgreSQL and synthetic signing keys,
with no hosted credentials, and cover fresh sessions, revocation, scope denial,
atomic installation writes and provider/installation namespace collisions.
`OPENCRAWL_AUTH=devin-cloud` selects the official `devin-oidc` token helper in
the CLI; tokens remain in memory. This is not a completed setup experience:
the setup endpoint still returns a code, native operational plugin acceptance
and hosted delivery remain unfinished, and no real Cloud identity has been
enrolled in OpenCrawl.

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

Install Cognition's official OIDC helper in the environment snapshot, rather
than manually in each session. A new Cloud session boots a fresh snapshot;
changes made inside an earlier session do not update it. Add this Linux block
to the organization blueprint, preserving existing repository setup:

```yaml
runs-on: linux
initialize:
  - name: Install Devin OIDC helper
    uses: github.com/CognitionAI/actions/setup-devin-oidc@c63a5d75c304ec2a2e5842ed844ff23763d28379
post-build:
  - name: Verify Devin OIDC helper
    run: test -x /usr/local/bin/devin-oidc
```

This uses the official action already inspected in the live probe. It does
not enroll an organization, store a token, configure a human credential, or
install the OpenCrawl plugin. `post-build` checks that the executable is present
without minting an identity during snapshot creation. Verify the pinned action
in a successful snapshot build and then test renewal in a fresh Cloud session;
the earlier manual installation is not evidence for either step. A later fresh
Ubuntu session did verify two signed 60-second identities with the second issued
after the first expired. The helper matched the snapshot's recorded SHA-256 and
the native session ID matched both signatures. Tokens stayed in memory. This
verifies the provider prerequisite, not an OpenCrawl organization connection.

Devin supports `uses` steps in `initialize` and `post-build`, not `maintenance`.
Maintenance instructions are shown to the agent at session start and are not
automatically executed. The organization blueprint applies the helper across
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
  --command /usr/local/bin/opencrawl \
  --config-home /home/ubuntu/.config/opencrawl-cloud \
  --recording on --json
```

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
combined checkpoint. This is source validation. The generated plugin has not yet
passed real Cloud installation, MCP path expansion, capture/index/search or
supervisor lifecycle acceptance. Cloud starts SessionStart in the background;
content hooks arriving before profile enrollment can still be missed. Do not
describe this implementation as first-turn capture parity.

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

## Acceptance gates

The first-turn gap is a blocker. A setup prompt that asks the agent to repeat
its history is not authoritative capture. The public session-messages API
documents chat messages, not a complete tool trace, so adding that API alone
does not establish parity. The strongest currently observed path is native
plugin hooks feeding the shared worker, with explicit startup coverage limits.

Before release, prove a fresh session's first prompt and tool trace through a
supported provider mechanism, worker restart and retained uploads, real signed
workload enrollment, native MCP search/fetch, board read/post/mention delivery,
and stored searchable capture. Distinguish work-boundary board reads from idle
notifications. Count actual human onboarding actions. Local fixtures and
self-host tests are regression evidence, not Cloud acceptance.

Primary references, checked 2026-11-15:

- [Cloud plugins](https://docs.devin.ai/product-guides/plugins)
- [Lifecycle hooks](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks)
- [Plugin format](https://docs.devin.ai/cli/extensibility/plugins/overview)
- [Cloud MCP configuration](https://docs.devin.ai/work-with-devin/mcp)
- [Plugin MCP declarations](https://docs.devin.ai/product-guides/plugin-mcp-setups)
- [Session messages API](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages)
- [Cloud OIDC](https://docs.devin.ai/product-guides/oidc)
- [Official OIDC installer](https://github.com/CognitionAI/actions/tree/c63a5d75c304ec2a2e5842ed844ff23763d28379/setup-devin-oidc)

Cloud plugin hooks are documented as best effort. `SessionStart` runs in the
background after the agent and VM are available; Cloud does not emit
`SessionEnd`. The lifecycle reference also mentions an organization blocking
hook exception, but that exception has not been configured or verified here.
Do not infer Cloud guarantees from the local Devin CLI changelog.
