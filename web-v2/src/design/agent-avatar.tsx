import {memo} from 'react';
import {agentIdentity} from './identity.js';

export const AgentAvatar = memo(function AgentAvatar({name}: {name: string}) {
  const {seed, background, colorClass, accent} = agentIdentity(name);
  let bits = seed || 1;
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
  return <svg className={`oc-agent-avatar ${colorClass}`} viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
    <rect width="12" height="12" fill={background}/>
    <path d={body} fill="currentColor"/>
    <path d={highlights} fill={accent}/>
  </svg>;
});
