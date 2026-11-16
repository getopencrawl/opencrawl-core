# Installation verification

Setup is optional product status, scoped to the authenticated user and organization.
It never gates workspace pages, integrations, invitations, or search. Core owns the
same protocol for customer-operated and hosted deployments; the runtime supplies
current authentication and the existing authorized search/fetch operations.

Each installation has a stable local installation ID, a machine label, and separate
client rows. Plugin installation, future capture, and historical import are independent
choices. Local observations and import progress cannot write proof or MCP receipts.
Legacy per-user onboarding receipts do not populate these client rows.

## Agent flow

1. The CLI applies the accepted setup choices and publishes its observations.
2. Run `opencrawl verify-installation --installation-id ID --client CLIENT --json`.
   It creates or checks one scoped proof. Do not fabricate transcript files or send
   synthetic capture batches. Do not ask the user to repeat steps already evidenced.
3. If future capture was selected, include the returned `proof.marker` in a normal
   assistant message in that client's native conversation. Let its installed hooks
   capture that new event. Old history, an unrelated session, and another client's
   activity cannot satisfy this proof.
4. In the same client and conversation, finish that client's own MCP sign-in if
   needed, then call the native `verify_installation` MCP tool with `installationId`,
   `client`, and `proofId`. The authenticated result contains a private receipt nonce.
   A CLI login, generic connection test, or terminal-emulated MCP call does not prove
   that the native client is connected.
5. Run the CLI verification again after capture/indexing catches up. Report capture
   proof and MCP state separately. One verified client is the first win; leave each
   other client in its own pending or unselected state. Historical import continues
   independently in the background.

Human tasks are limited to controls that require the user: each client's own hook
trust UI and MCP sign-in. A captured native message suppresses repeat hook-trust
requests without claiming the CLI changed the client's trust settings.

## Evidence contract

`proof.state=verified` requires a post-challenge live message received through durable
capture for the selected installation and harness. Its event time must follow both
the challenge and the server's future-capture selection boundary. The authorized
workspace search must return the challenge marker with the exact uploader,
installation, harness, session, and event IDs; authenticated fetch must independently
return that same passage and marker. An explicit recheck does not reuse a removed
search passage. `firstWin` records the first successful check, not a perpetual
availability claim.

`mcp.state=observed` means the server received an authenticated, proof-specific MCP
call from the same principal. `authenticated` additionally requires the native
captured verification tool call and its matching tool-result call ID containing the
private receipt, in the same installation, harness, and session as the captured
message. Claude's nested `tool_use`/`tool_result` blocks and Codex's separate native
call/result events are supported. A result shown by a shell command is insufficient.
Clients or wrappers without captured native call/result correlation remain observed;
the server does not guess from self-reported MCP client names. This is product
evidence, not a hardware attestation or new authorization grant.

For search-only or history-only use, `proof.state=not_selected` leaves capture off.
A registered client may still obtain an MCP proof ID and reach transport-observed
status. It is not required to enable capture to search existing authorized data.

## Runtime integration

- Construct `createSetupStatus({state, search: authorizedSearch})` from
  `@getopencrawl/opencrawl-core/setup/status` using the ready core
  `ApplicationState`. Its PostgreSQL setup repository provides atomic conditional
  writes scoped to the authenticated tenant and user. Existing deployments must
  complete their application-state migration before starting this service.
- The CLI uses `GET /api/setup`, `POST /api/setup/installation`, and
  `POST /api/setup/verify` through `createSetupHandler({setup, authenticate})` from
  `@getopencrawl/opencrawl-core/setup/http`. Responses are
  `{schemaVersion: 1, data: ...}`. Capture-only credentials, body-selected scope,
  origin-bearing CLI requests, and unknown fields fail closed.
- Browser `GET /api/setup` calls `setup.read` with the admitted principal and
  revalidates access before returning. `setup.status` in the shared web RPC maps
  this response to `SetupStatus`.
- Call `setup.session(principal, batch)` only after raw storage and durable indexing
  handoff succeed. The bounded onboarding observer can combine this with legacy
  receipts; optional observation failure must not change a committed capture result.
- Pass `setup` to `createOpenCrawlMcp` to register `verify_installation`. Only that
  authenticated transport invokes `setup.mcp`; the receipt nonce is never exposed
  in the public status or CLI verification response.

The self-host application implements these seams with local Better Auth OAuth and
its existing storage/search adapters. It requires no hosted OpenCrawl credentials.
The local regression covers real durable ingest, SQLite indexing, authenticated MCP
transport, search/fetch provenance, and captured native correlation.

The first release offers Claude Code and Codex client setup on macOS. Record
actual native capture, authenticated MCP, search and fetch evidence separately
from these fixtures; deferred clients and platforms remain unverified until
their own journeys pass.
