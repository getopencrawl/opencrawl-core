# Guided onboarding

The shared product renderers live in `src/onboarding*.mts`. The document frame,
icons, controls and browser JSON transport are reused across all three steps.
The hosted adapter supplies identity, scope, connector authorization, invitations,
billing admission and routing. It never copies the core product UI.

## Progress and gates

`createOnboardingStatus` persists individual receipts under the authenticated
user and tenant scope. Step one requires CLI authentication, a successful native
MCP `test_connection`, and an accepted batch containing a recorded message.
MCP initialization is not a connection-test receipt. Hook-only batches cannot
complete recording. New CLI batches mark `captureMode` as `live` or `history`;
history updates a separate optional receipt and cannot unlock recording. Legacy
batches remain supported. Their original capture mode cannot be reconstructed.

CLI installation alone is not evidence of recorded messages, so the recording
parent remains pending until a live recording is stored. History shows Received
when a historical batch is accepted; this does not claim the entire import has
finished. The CLI's own final report describes full-import completion.

Step one never advances automatically. Its Next action opens Sources only after
the required receipts exist. Sources requires at least one authorized connection;
indexing may continue in the background. Starting OAuth is not a connection.
The provider callback returns to Sources without advancing the onboarding step.
The catalog comes from the current hosted service, not a copied provider list.
Search appears only for catalogs of at least fifteen connectors.

The final teammate step is optional. Admins can invite one email at a time;
ordinary members can continue without seeing or sending invitations. WorkOS owns
invitation delivery and the existing hosted service always assigns member access.
The browser receives email-only invitation DTOs, never tokens or membership roles.

Both Skip for now and Open workspace POST to the authenticated finish endpoint.
The adapter rechecks the agent and source gates before saving a durable completed
receipt. It then opens `/`, the actual workspace home backed by authorized search.
Completion is idempotent and scoped. Disconnecting sources later does not relock
an already completed workspace. Existing receipts are retained; absent new
milestones are shown rather than inferred from clicks or stored browser state.

## Presentation and recovery

All steps share the boxed, left-aligned shell and bounded header with Sign out.
Forward navigation sits outside the panel at the right; Back stays quiet with
matching arrow insets. The primary button's brand layers appear only on hover.
Checklist disclosures close when their receipt first becomes complete. Prompt
and snippet copy feedback clears after 1.5 seconds; disclosure changes are instant.
Clipboard failures retain a usable manual-copy path.

The release contains no preview controls, simulated APIs, variant switches or
mock workspace. Hosted route tests use synthetic identity/provider adapters;
real authentication, provider authorization, delivery and retrieval remain live
release acceptance checks. Core and CLI checks run independently without hosted
credentials. Publish immutable core and CLI versions, then advance the hosted
package, integrity lock and Git source pin together before deployment.
