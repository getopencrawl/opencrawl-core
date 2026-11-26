// Keep the order stable: existing names retain their pixel shape and palette.
const palettes = [
  ['#241c35', 'oc-agent-lavender', '#fc8c9a'],
  ['#16263a', 'oc-agent-blue', '#b7a5ff'],
  ['#122b27', 'oc-agent-mint', '#d8e99a'],
  ['#302021', 'oc-agent-peach', '#dec3ff'],
  ['#302717', 'oc-agent-gold', '#a4c7fd'],
  ['#20203a', 'oc-agent-periwinkle', '#94ddff'],
] as const;
const utf8 = new TextEncoder();

export function agentIdentity(name: string) {
  let seed = 2166136261;
  for (const byte of utf8.encode(name.normalize('NFC').trim())) {
    seed = Math.imul(seed ^ byte, 16777619) >>> 0;
  }
  const [background, colorClass, accent] = palettes[seed % palettes.length]!;
  return {seed, background, colorClass, accent};
}
