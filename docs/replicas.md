# Replicas organization connections

A workspace admin opens **Agent setup**, chooses **Install on Replicas**, and
pastes the generated prompt into the intended Replicas workspace. The prompt
contains a one-time setup capability valid for 30 minutes. OpenCrawl stores only
its hash. Enrollment also requires a signed Replicas workspace token minted for
this OpenCrawl origin. The request cannot supply a destination tenant or a
Replicas organization: those come from the admin approval and the verified token.
The approving admin must still be an active admin when the prompt is redeemed.

The resulting organization connection is ordinary product data in the configured
object store. It authorizes native identities from that Replicas organization,
including new environments and personal environment forks. No long-lived human
or machine API key, environment allowlist, or AWS Parameter Store configuration
is required for new connections. A Replicas organization cannot be connected to
two OpenCrawl organizations. An environment ID still contributes to the stable
workspace owner ID; migration never rewrites existing owners or captured data.

The prompt configures the supported persistent Replicas environment hooks and
native MCP identity authentication. One workspace must produce actual CLI,
MCP test, and fresh-session receipts before OpenCrawl reports the team setup as
ready. Imported history and a successful enrollment cannot satisfy that check.
The receipt writer records the verified shared installation automatically; no
operator needs to nominate a VM after setup. Everyone in the OpenCrawl workspace
can use that shared setup, and **Set up a personal computer** retains the normal
personal login and capture path in the same workspace.

The workspace is a shared principal. It does not inherit its creator's personal
permissions. Message authorship remains separate from authentication; names and
email text are not verified human identity. Existing private-resource rules apply.

## Storage and migration

`identity/replicas-v1/organizations/<org>.json` is the authoritative connection,
written with conditional updates. The tenant indexes only locate records; reads
recheck the record's tenant and revocation state. Setup hashes live under
`identity/replicas-v1/setup/`. Neither location contains Replicas tokens.
The same adapter operates in self-hosted installations and pins their configured
single organization. Hosted routing supplies the verified connection's tenant.

`createReplicasConnections.migrateLegacy` imports an operator-approved legacy
configuration. It validates the whole input for conflicting tenants before writing,
preserves existing shared-installation owner IDs and references to real receipts,
is retryable across partial writes, and cannot restore a revoked connection.
It is an operator operation, never an HTTP endpoint accepting user-provided rows.

During a staged hosted rollout, an absent connection may continue using the old
exact-environment admission. A present connection is authoritative: denial,
revocation, or a storage error must never fall back to legacy admission. Migrate
and verify the operator's own organization first, then each customer organization.
Retain the legacy configuration and previous runtime for rollback until the new
runtime is independently verified. Remove deployment readers and the legacy
parameter only after every approved organization resolves through product data.
Do not leave a permanent dual source of authority.

Existing VMs may retain their creation-time startup scripts. Updating Global
controls new workspaces; the authorization migration does not require developers
to log in again, replace their tokens, or reassign their recorded sessions.

## Runtime verification, capture and lifecycle

The verifier fixes the issuer and JWKS URL to `https://api.replicas.dev`, accepts
only RS256, checks the exact receiver origin as audience, validates all scope IDs
and their matching subject, and rejects a lifetime over 15 minutes. Key discovery
never follows token-supplied URLs. A workload has a stable principal derived from
its verified workspace subject, distinct from every human member.

Inside an admitted Replicas environment, set `OPENCRAWL_API_URL` to the receiver
origin and `OPENCRAWL_AUTH=replicas-workspace`. Remove `OPENCRAWL_TOKEN` and
`OPENCRAWL_SESSIONS_TOKEN`. The CLI invokes the supported `replicas identity token`
helper for that audience, keeps tokens only in memory, and renews them during long
uploads and board listening. It refuses mixed workload/human credentials and
never falls back to a saved human login if workspace authentication fails.

Configure remote MCP with Replicas' `workspace_identity` authentication and the
same audience. MCP authentication is separate from local capture hooks; Codex
still requires its supported hook trust review. This feature does not approve
hooks or change agent security settings.

Workloads may search team-visible knowledge, participate on the board, and upload
sessions/memory. They cannot use account/team/billing administration, mint other
credentials, or read a human member's private captures. Capture writes remain
bound to the authenticated workload owner. Existing human-owned queues must be
drained under their original credentials before changing installation ownership.

Sessions belong to the workspace principal and may contain messages from several
people or inputs with no known human author. An unknown author is valid. Native
message content retains Replicas author envelopes, including a `From` label when
the provider supplies one. Those labels are source text, not verified human
identities or permission grants. The collector enriches Claude messages with a
structured actor only through exact provider/native message IDs. A missing Codex
ID link limits structured author lookup; it does not by itself mean the source
envelope or conversation was lost. Do not create duplicate messages to replace
an envelope that is already captured.

Workspace creator metadata is not a per-message author. Personal-account
delegation and browser onboarding remain separate from shared-workspace setup.
Enabling this adapter alone does not prove capture, resource administration for
workload-owned data, or lifecycle recovery.

## Retention and intentional deletion

API-created workspaces and automations can default to `delete_when_done`; their
history becomes unreadable after deletion. Use `lifecycle_policy: "default"` or
`"sleep_when_done"` when creating capture-enabled workspaces. Existing workspaces
and automation definitions need their own checks; an environment start hook does
not establish their creation policy.

For intentional permanent deletion, finish all agent turns and prevent new input,
run `opencrawl collect flush --json`, then inspect `opencrawl collect status --json`.
Require no queued batches, pending hooks, rejected batches or capture error, and
verify the final message's stored receipt before deleting. Leave the workspace
intact if verification fails. Keep history retention enabled while relying on
sleep/archive recovery; retained history is not an indefinite backup.

This procedure covers controlled deletion after successful capture. It cannot
recover bytes destroyed before upload or make provider completion webhooks wait
for an upload acknowledgement. See the provider's [lifecycle documentation](https://docs.replicas.dev/features/api)
and [retention controls](https://docs.replicas.dev/admin/data-retention).

Replicas chat names are resolved through an exact native-thread match in the
platform history API. The CLI caches this metadata for 30 seconds across workers;
it does not mistake the SDK's generic `Claude Code` title for the platform name.
`opencrawl collect titles` refreshes names for already enrolled sessions without
replaying their conversation. A metadata/provenance API failure keeps local data
for retry and must not be reported as complete capture. Platform title metadata
is descriptive and grants no authentication or resource access.

## Shared installation onboarding

Administrators can use **Install on Replicas** in Agent setup to copy a dedicated
setup prompt into a Replicas chat. It covers the persistent environment, workload
authentication and fresh-session verification. The first release still requires
the deployment operator to approve the environment binding and designate the
verified workspace; the prompt reports this once rather than requesting personal
credentials from every member.

An operator may add `onboardingWorkspaceId` to an approved Replicas binding after
an administrator chooses one workspace for installation verification. The
receiver reads that exact workload owner's real CLI, MCP test and fresh capture
receipts. Once all three exist, members of the bound tenant can open the product
without installing a local agent. The API reports a separate `shared` setup
receipt and never fabricates human setup records. History imports do not count.
Removing approval immediately removes this alternative on the next status read;
ordinary completed personal setup remains valid. Self-host uses the same binding
and receipt logic without hosted credentials.

The authenticated principal has an explicit `owner.kind: shared` descriptor.
Stable workload IDs and existing captured object paths remain unchanged. Message
authors are independent provenance and do not become permissions. This change
does not grant shared principals access to private human resources or admin APIs.
