/** Derive setup progress from durable receipts, never clicks or elapsed time. */
export const hasReceipt = (value: unknown) => typeof value === 'object' && value !== null && 'observedAt' in value && typeof value.observedAt === 'string'
    && value.observedAt.trim() !== '' && Number.isFinite(Date.parse(value.observedAt));
export const hasCompletedOnboarding = (status?: {completed?: unknown; shared?: unknown} | null) => hasReceipt(status?.completed) || hasReceipt(status?.shared);
export function deriveOnboarding(status?: {cli?: unknown; mcpTest?: unknown; session?: unknown; mcp?: unknown; shared?: unknown} | null) {
  if (hasReceipt(status?.shared)) return {complete: true, step: 'ready', completedCount: 3};
  const receipt = hasReceipt;
  const milestones = [receipt(status?.cli), receipt(status?.mcpTest), receipt(status?.session)];
  const completedCount = milestones.filter(Boolean).length;
  const next = milestones.indexOf(false);
  // A successful tool call already proves MCP access, even if its sign-in receipt is absent.
  const step = next === 1 && !receipt(status?.mcp) ? 'mcp' : ['connect', 'verify', 'session'][next] ?? 'ready';
  return {complete: next === -1, step, completedCount};
}
