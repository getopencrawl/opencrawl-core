# Onboarding release QA

The finalized flow is tested through the hosted application handler, not a
standalone mock product server. Synthetic identity and provider adapters are
confined to test fixtures; production exposes no state-simulation endpoints.

Core tests cover durable receipts, user/tenant isolation, MCP sign-in versus
successful tool invocation, storage failures, history versus live recording,
hook-only batches, authenticated single-tenant operation and completion retries.
CLI tests verify interactive backfill consent and the explicit history marker.
Hosted route tests cover all three step gates, source sign-in versus authorization,
source indexing, invitation validation/retry/deduplication, admin/member roles,
CSRF, durable optional completion and real workspace-search result contracts.

Browser acceptance covers dynamic headings, manual disclosures, prompt preview,
auto-collapse on receipt, no automatic advancement, source authorization return,
API-key entry, invitation rows, keyboard entry, final navigation and search.
Desktop and phone renders preserve the approved frame, alignment and controls.
Actual hosted identity/provider interactions are verified separately on release.
