import type {DiagnosticHit, DiagnosticSearch, SearchResponse} from './types.js';

export type SearchSource = 'sessions' | 'connectors' | 'memories';
export interface SearchGroup {
  id: SearchSource;
  label: string;
  hits: DiagnosticHit[];
  state: string;
  total?: number;
  totalRelation?: 'eq' | 'gte';
  truncated: boolean;
  warnings: string[];
}
const string = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Returned counts are not totals. Preserve coverage reported by each adapter. */
export function searchGroups(data: DiagnosticSearch): SearchGroup[] {
  function group(id: SearchSource, label: string, responses: SearchResponse[], state?: string, truncated = false): SearchGroup {
    const hits = responses.flatMap(response => response.hits?.hits || []);
    const states = [state, ...responses.map(response => response.state)].filter((value): value is string => Boolean(value));
    const knownResponse = responses.some(response => Array.isArray(response.hits?.hits));
    const unavailable = states.find(value => !['ready', 'pending', 'not_configured'].includes(value));
    const resolved = unavailable || states.find(value => value === 'pending') || states.find(value => value === 'not_configured') ||
      (knownResponse || state === 'ready' || (id === 'connectors' && Array.isArray(data.connectors?.responses)) ? 'ready' : 'unknown');
    const totals = responses.map(response => response.hits?.total);
    const total = totals.length && totals.every(value => count(value?.value))
      ? totals.reduce((sum, value) => sum + value!.value, 0) : undefined;
    const totalRelation = totals.some(value => value?.relation === 'gte') ? 'gte' : 'eq';
    const limited = truncated || responses.some(response => response.truncated === true);
    const warnings: string[] = [];
    if (resolved === 'pending') warnings.push('Indexing is pending. Results may be incomplete.');
    else if (resolved === 'not_configured') warnings.push('This source is not configured.');
    else if (resolved === 'unavailable') warnings.push('This source is temporarily unavailable.');
    else if (resolved !== 'ready') warnings.push('This source did not report search coverage.');
    if (responses.some(response => response.timed_out)) warnings.push('The search timed out. Returned results may be incomplete.');
    if (responses.some(response => (response._shards?.failed || 0) > 0)) warnings.push('Some index shards failed. Returned results may be incomplete.');
    if (limited) warnings.push('Results are limited. Narrow the query for a more focused inspection.');
    return {id, label, hits, state: resolved, ...(total !== undefined ? {total, totalRelation} : {}), truncated: limited, warnings};
  }
  return [
    ...(data.sessions?.length ? [group('sessions', 'Agent sessions', data.sessions.map(item => item.response))] : []),
    ...(data.connectors ? [group('connectors', 'Connected sources', data.connectors.responses || [], data.connectors.state, data.connectors.truncated)] : []),
    ...(data.memories ? [group('memories', 'Agent memories', [data.memories], data.memories.state, data.memories.truncated)] : []),
  ];
}

/** A verbatim snippet around the first literal query match, never HTML or a summary. */
export function excerpt(value: string, query: string, limit = 700) {
  const index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = index >= 0 && value.length > limit ? Math.max(0, index - 140) : 0;
  return {text: value.slice(start, start + limit), leading: start > 0, trailing: start + limit < value.length};
}
export function highlightedText(value: string, query: string): Array<{text: string; match: boolean}> {
  if (!query.trim()) return [{text: value, match: false}];
  // Escaped literal matching keeps query operators and source markup inert.
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const parts: Array<{text: string; match: boolean}> = [];
  let start = 0;
  for (const found of value.matchAll(expression)) {
    if (found.index > start) parts.push({text: value.slice(start, found.index), match: false});
    parts.push({text: found[0], match: true}); start = found.index + found[0].length;
  }
  if (start < value.length) parts.push({text: value.slice(start), match: false});
  return parts;
}

export function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/u.test(value)) return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname) return;
    return url.href;
  } catch {return;}
}
const names: Record<string, string> = {codex: 'Codex', 'claude-code': 'Claude Code', 'grok-bot': 'Grok Bot', opencode: 'OpenCode', cursor: 'Cursor', muse: 'Muse Code', claude: 'Claude', slack: 'Slack', notion: 'Notion', github: 'GitHub', google_drive: 'Google Drive', granola: 'Granola', circleback: 'Circleback'};
function readable(value: string) {return names[value] || value.replace(/[_-]+/g, ' ').replace(/^./u, letter => letter.toLocaleUpperCase());}
function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return;
  if (typeof value === 'string' && !value.trim()) return;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
export interface SearchHitPresentation {
  title: string;
  body: string;
  serverExcerpt: boolean;
  context: Array<{label: string; value: string}>;
  timestamp?: string;
  timestampLabel?: string;
  url?: string;
}
export function searchHit(hit: DiagnosticHit, source: SearchSource): SearchHitPresentation {
  const document = hit._source || {};
  const provider = readable(string(document.provider)), harness = readable(string(document.harness));
  const kind = readable(string(document.kind)), role = readable(string(document.role));
  const identity = source === 'connectors' ? provider : harness;
  const type = [role, kind].filter(Boolean).join(' ');
  const suppliedTitle = string(document.title) || (source === 'memories' ? string(document.path) : '');
  const fallbackTitle = [identity, type].filter(Boolean).join(' ');
  const title = suppliedTitle || fallbackTitle || (source === 'memories' ? 'Agent memory' : 'Indexed item');
  const contextInTitle = !suppliedTitle || suppliedTitle.toLocaleLowerCase() === fallbackTitle.toLocaleLowerCase();
  const context: SearchHitPresentation['context'] = [];
  if (!contextInTitle && identity && identity !== title) context.push({label: source === 'connectors' ? 'Source' : 'Harness', value: identity});
  if (!contextInTitle && type && type !== title) context.push({label: 'Type', value: type});
  const fields = source === 'sessions' ? [['Session', 'sessionId'], ['Project', 'project']]
    : source === 'memories' ? [['Path', 'path'], ['Project', 'project']]
    : [['Channel', 'channelId'], ['Heading', 'heading']];
  for (const [label, key] of fields) {
    const value = string(document[key!]);
    if (value && value !== title) context.push({label: label!, value});
  }
  const dates = [['timestamp', 'Recorded'], ['modifiedAt', 'Modified'], ['receivedAt', 'Received']] as const;
  const date = dates.map(([key, label]) => ({value: timestamp(document[key]), label})).find(item => item.value);
  const body = typeof document.text === 'string' ? document.text : '';
  const excerpt = document.excerpt;
  const serverExcerpt = typeof excerpt === 'object' && excerpt !== null && 'totalChars' in excerpt &&
    count(excerpt.totalChars) && excerpt.totalChars > body.length;
  const url = safeSourceUrl(document.url);
  return {title, body, serverExcerpt, context,
    ...(date ? {timestamp: date.value, timestampLabel: date.label} : {}), ...(url ? {url} : {})};
}
