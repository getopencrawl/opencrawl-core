# Onboarding receipts

The portable onboarding page polls an authenticated GET /api/onboarding.
createOnboardingStatus from @getopencrawl/opencrawl-core/onboarding/status stores
three independent milestones under the configured session prefix and trusted
tenant/user scope: CLI authentication observed, authenticated MCP exchange
observed, and session batch durably accepted. Each includes observedAt;
this is historical setup evidence, not a promise that a device remains online or
credentials have not since been revoked. No session text, tokens, emails or
client-supplied owner names enter these receipts.

The single-tenant capture receiver supplies this endpoint under the same operator
token and configured principal as capture. GET /api/sessions/identity records
CLI authentication; accepted uploads record session receipt. An independently
constructed MCP runtime can use the same store/prefix and pass status.mcp as
createOpenCrawlMcp({onAuthenticated}) with the same trusted tenant/user principal.
This hook is a best-effort observation after the authenticated exchange, never an
authorization gate. A receipt error or timeout preserves the original tool
response, including an already committed board write. Normal receipts are
awaited for up to `observationTimeoutMs` (default 1000, range 1–10000 ms); a timed
out observer may finish later. `onObservationError` receives bounded protocol
metadata only and defaults to a generic log event; its own failure cannot affect
the tool response.
MCP client names are self-reported display metadata, never authorization inputs.
Unknown clients render without a brand. The UI has no simulated success.

For custom browser runtimes, authenticate the status endpoint using the same
principal as capture/MCP and supply displayName from verified account data.
Render renderOnboarding({mcpUrl,setupPrompt,integrationsUrl}) and serve the core
onboarding JS/CSS and controls alongside tokens/assets. The hosted shell supplies
its own login and integrations routes; this UI does not require WorkOS.

