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

Workspace creator metadata is not a per-message author. Sender attribution,
resource administration for workload-owned data, native transcript normalization,
and lifecycle reconciliation require separate acceptance. Enabling this adapter
alone does not establish local-machine parity or mark every team member onboarded.
