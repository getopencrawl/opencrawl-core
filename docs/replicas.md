# Replicas workspace identity

Replicas can supply a signed, short-lived workspace identity to OpenCrawl. The
operator explicitly admits an organization/environment pair. Neither an email
domain nor a workspace creator establishes tenant access.

For self-hosting, set `OPENCRAWL_REPLICAS_BINDINGS` to a JSON array containing
`organizationId` and `environmentId`. The receiver always pins these bindings to
`OPENCRAWL_ORGANIZATION_ID`; a conflicting `tenantId` is rejected. Hosted adapters
also supply an explicit `tenantId` for every binding. Duplicate pairs fail closed.
Removing the binding and restarting the receiver revokes admission even while
previously issued Replicas tokens remain unexpired.

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
