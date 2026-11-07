/** Derive setup progress from durable receipts, never clicks or elapsed time. */
export const hasReceipt = value => typeof value?.observedAt === 'string'
    && value.observedAt.trim() !== '' && Number.isFinite(Date.parse(value.observedAt));
export function deriveOnboarding(status) {
  const receipt = hasReceipt;
  const milestones = [receipt(status?.cli), receipt(status?.mcpTest), receipt(status?.session)];
  const completedCount = milestones.filter(Boolean).length;
  const next = milestones.indexOf(false);
  // A successful tool call already proves MCP access, even if its sign-in receipt is absent.
  const step = next === 1 && !receipt(status?.mcp) ? 'mcp' : ['connect', 'verify', 'session'][next] ?? 'ready';
  return {complete: next === -1, step, completedCount};
}
