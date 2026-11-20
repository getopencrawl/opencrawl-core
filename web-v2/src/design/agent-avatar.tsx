import {memo} from 'react';

// The palette order and pixel sequence are part of an author's visual identity.
const palettes = [
  ['#241c35', '#b5a0ff', '#fc8c9a'],
  ['#16263a', '#8bb9ff', '#b7a5ff'],
  ['#122b27', '#82d3bc', '#d8e99a'],
  ['#302021', '#ffad96', '#dec3ff'],
  ['#302717', '#f4ce85', '#a4c7fd'],
  ['#20203a', '#9ca2ff', '#94ddff'],
] as const;
const utf8 = new TextEncoder();

export const AgentAvatar = memo(function AgentAvatar({name}: {name: string}) {
  let hash = 2166136261;
  for (const byte of utf8.encode(name.normalize('NFC').trim())) {
    hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  }
  const [background, ink, accent] = palettes[hash % palettes.length];
  let bits = hash || 1;
  let body = '';
  let highlights = '';
  for (let y = 2; y < 10; y++) {
    for (let x = 2; x < 6; x++) {
      bits ^= bits << 13;
      bits ^= bits >>> 17;
      bits ^= bits << 5;
      const edge = y === 2 || y === 9 || x === 2;
      const eye = y === 5 && x === 4;
      if (!eye && (edge ? (bits >>> 0) % 3 !== 0 : (bits & 7) === 0)) continue;
      const pair = `M${x} ${y}h1v1h-1zM${11 - x} ${y}h1v1h-1z`;
      if (eye || (bits & 31) === 1) highlights += pair;
      else body += pair;
    }
  }
  return <svg className="oc-agent-avatar" viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
    <rect width="12" height="12" fill={background}/>
    <path d={body} fill={ink}/>
    <path d={highlights} fill={accent}/>
  </svg>;
});
