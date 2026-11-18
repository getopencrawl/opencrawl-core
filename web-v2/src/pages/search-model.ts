import type {DiagnosticHit, DiagnosticSearch, SearchResponse} from './types.js';
import {promptText} from '../../../src/sessions/prompt-text.mjs';

export type SearchSource = 'sessions' | 'connectors' | 'memories' | 'board';
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
    ...(data.board ? [group('board', 'Message board', [data.board], data.board.state, data.board.truncated)] : []),
  ];
}

/** Report the page range once. A missing source total or incomplete search can only support a lower bound. */
export function resultSummary(groups: SearchGroup[], page: number, pageSize: number, hasNext: boolean, partial: boolean) {
  const returned = groups.reduce((sum, group) => sum + group.hits.length, 0);
  if (!returned) return '0 results shown';
  const first = (page - 1) * pageSize + 1;
  const last = first + returned - 1;
  const range = first === last ? first.toLocaleString() : `${first.toLocaleString()}–${last.toLocaleString()}`;
  const reported = groups.reduce((sum, group) => sum + (group.total ?? 0), 0);
  const lowerBound = partial || groups.some(group => group.total === undefined || group.totalRelation === 'gte');
  if (reported > last || (page > 1 && reported === last && !hasNext)) {
    return `${range} of ${lowerBound ? 'at least ' : ''}${reported.toLocaleString()} results`;
  }
  if (page > 1 || hasNext) return `${returned === 1 ? 'Result' : 'Results'} ${range}`;
  return `${returned.toLocaleString()} ${returned === 1 ? 'result' : 'results'}${lowerBound ? ' shown' : ''}`;
}

/** A verbatim snippet around the first literal query match, never HTML or a summary. */
export function excerpt(value: string, query: string, limit = 700) {
  const lower = value.toLowerCase(), needle = query.trim().toLowerCase();
  let index = lower.indexOf(needle);
  if (index < 0) index = needle.split(/\s+/u).map(word => lower.indexOf(word)).filter(at => at >= 0).sort((a,b) => a-b)[0] ?? -1;
  const start = index >= 0 && value.length > limit ? Math.min(value.length - limit, Math.max(0, index - Math.floor(limit / 3))) : 0;
  return {text: value.slice(start, start + limit), leading: start > 0, trailing: start + limit < value.length};
}
export function highlightedText(value: string, query: string): Array<{text: string; match: boolean}> {
  if (!query.trim()) return [{text: value, match: false}];
  // Escaped literal matching keeps query operators and source markup inert.
  const terms = [...new Set([query.trim(), ...query.trim().split(/\s+/u)])].sort((a,b) => b.length-a.length);
  const expression = new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu');
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
const names: Record<string, string> = {codex: 'Codex', 'claude-code': 'Claude Code', cursor: 'Cursor', 'grok-bot': 'Grok Bot', antigravity: 'Antigravity', claude: 'Claude', slack: 'Slack', notion: 'Notion', github: 'GitHub', google_drive: 'Google Drive', granola: 'Granola', circleback: 'Circleback'};
function readable(value: string) {return names[value] || value.replace(/[_-]+/g, ' ').replace(/^./u, letter => letter.toLocaleUpperCase());}
function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return;
  if (typeof value === 'string' && !value.trim()) return;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
export interface SearchHitPresentation {
  title: string;
  userPrompt: boolean;
  body: string;
  serverExcerpt: boolean;
  context: Array<{label: string; value: string}>;
  timestamp?: string;
  timestampLabel?: string;
  url?: string;
}
/** Untitled hits borrow a literal piece of the matching passage. Tool output
 * often contains a filename inside a JSON string or a list of changed paths. */
function passageTitle(body: string, query: string): string {
  const needle = query.trim().toLowerCase();
  if (!needle) return '';
  const index = body.toLowerCase().indexOf(needle);
  if (index < 0) return '';
  const around = body.slice(Math.max(0, index - 120), index + needle.length + 120);
  const line = around.split(/\r?\n|\\[rn]/u).find(part => part.toLowerCase().includes(needle))?.trim();
  if (!line) return '';
  const path = line.match(/[^\s"'<>:{}[\],\\]+\/[^\s"'<>:{}[\],\\]+/gu)
    ?.find(part => part.toLowerCase().includes(needle));
  if (path) {
    const label = path.split('/').filter(Boolean).slice(-2).join('/');
    if (label.length <= 90) return label;
  }
  if (/[{}]|":/u.test(line)) return '';
  if (line.length <= 90) return line;
  const match = line.toLowerCase().indexOf(needle);
  const start = Math.max(0, match - 32);
  const words = line.slice(start, start + 88).replace(start ? /^\S*\s+/u : /^$/u, '').trimEnd();
  return (start ? '…' : '') + words + (start + 88 < line.length ? '…' : '');
}

export function searchHit(hit: DiagnosticHit, source: SearchSource, query = ''): SearchHitPresentation {
  const document = hit._source || {};
  const provider = readable(string(document.provider)), harness = readable(string(document.harness));
  const kind = readable(string(document.kind)), role = readable(string(document.role));
  const identity = source === 'connectors' ? provider : harness;
  const indexed = typeof document.text === 'string' ? document.text : '';
  const userMessage = source === 'sessions' && (document.role === 'user' || document.kind === 'user_message') &&
    document.containsToolOutput !== true && !['tool_result', 'tool_call'].includes(string(document.kind));
  const prompt = userMessage ? promptText(indexed) : null;
  const queryTerms = query.toLowerCase().trim().split(/\s+/u);
  const userPrompt = Boolean(prompt) && (prompt === indexed.trim() || queryTerms.some(term => prompt!.toLowerCase().includes(term)));
  const body = userPrompt && prompt ? prompt : indexed;
  const type = userMessage ? (userPrompt ? 'User prompt' : 'Session context')
    : source === 'sessions' && role === 'Assistant' && kind === 'Message' ? 'Assistant reply' : [role, kind].filter(Boolean).join(' ');
  const channel = string(document.channel);
  const suppliedTitle = string(document.title) || (source === 'memories' ? string(document.path) : '');
  const fallbackTitle = [identity, type].filter(Boolean).join(' ');
  const title = source === 'board' ? (channel ? '#' + channel : 'Message board')
    : suppliedTitle || (source === 'sessions' ? (harness ? harness + ' session' : 'Session history') : passageTitle(body, query) || fallbackTitle || (source === 'memories' ? 'Agent memory' : 'Indexed item'));
  const contextInTitle = title.toLocaleLowerCase() === fallbackTitle.toLocaleLowerCase();
  const context: SearchHitPresentation['context'] = [];
  if (!contextInTitle && identity && identity !== title) context.push({label: source === 'connectors' ? 'Source' : 'Harness', value: identity});
  if (!contextInTitle && type && type !== title) context.push({label: 'Type', value: type});
  if (source === 'board') context.push({label: 'Type', value: document.threadId === document.messageId ? 'Board post' : 'Board reply'});
  const fields = source === 'board' ? [['From', 'author']]
    : source === 'sessions' ? [['Project', 'project']]
    : source === 'memories' ? [['Path', 'path'], ['Project', 'project']]
    : [['Channel', 'channelId'], ['Heading', 'heading']];
  for (const [label, key] of fields) {
    const value = string(document[key!]);
    if (value && value !== title) context.push({label: label!, value});
  }
  const dates = [['timestamp', 'Recorded'], ['modifiedAt', 'Modified'], ['receivedAt', 'Received']] as const;
  const date = dates.map(([key, label]) => ({value: timestamp(document[key]), label})).find(item => item.value);
  const excerpt = document.excerpt;
  const serverExcerpt = typeof excerpt === 'object' && excerpt !== null && 'totalChars' in excerpt &&
    count(excerpt.totalChars) && excerpt.totalChars > body.length;
  const url = safeSourceUrl(document.url);
  return {title, userPrompt, body, serverExcerpt, context,
    ...(date ? {timestamp: date.value, timestampLabel: date.label} : {}), ...(url ? {url} : {})};
}
