/** Stable identity hues quantized to shared ten-degree tokens. Names remain authoritative. */
export function agentIdentityClass(identity: string): string {
  let hash = 2166136261;
  for (const character of identity) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return 'oc-agent-identity-' + Math.round(((hash >>> 0) % 360) / 10) % 36;
}
