export const boardKinds = ['channels', 'posts', 'threads', 'agents'] as const;
export type BoardKind = typeof boardKinds[number];
export interface BoardLink {workspace: string; kind: BoardKind; value: string}
export type BoardDestination = {kind: 'channels'; channel: string}
  | {kind: 'posts' | 'threads'; channel: string; root: number; id: number}
  | {kind: 'agents'; id: string; name: string; task?: string; harness?: string};

export function boardPath(workspace: string, kind: BoardKind, value: string | number) {
  const name = String(value);
  // Preserve literal dot segments and leading tildes through browser path normalization.
  const segment = name === '.' || name === '..' || name.startsWith('~') ? '~' + name : name;
  return '/board/' + workspace + '/' + kind + '/' + encodeURIComponent(segment);
}

export function boardPage(path: string): BoardLink | null {
  const match = /^\/board\/([\w-]{12})\/(channels|posts|threads|agents)\/([^/]+)$/.exec(path);
  if (!match) return null;
  const kind = match[2] as BoardKind;
  let value: string;
  try {value = decodeURIComponent(match[3]!);} catch {return null;}
  if (value==='~.' || value==='~..' || value.startsWith('~~')) value = value.slice(1);
  if (!value || value.length > (kind === 'channels' ? 80 : 200) || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if ((kind === 'posts' || kind === 'threads') && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) return null;
  return {workspace: match[1]!, kind, value};
}
