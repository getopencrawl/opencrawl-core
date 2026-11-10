import {CliError, jsonRequest} from './oauth.ts';
import {accessToken} from './session.ts';
import {environmentToken} from './environment-token.ts';

async function workspaceRequest(api: string, operation: 'search' | 'fetch', input: Record<string, unknown>, fetcher = fetch) {
  const configuredToken = environmentToken('OPENCRAWL_TOKEN', api);
  let token = configuredToken || await accessToken(api, undefined, fetcher);
  const request = () => jsonRequest(`${api}/api/search${operation === 'fetch' ? '/fetch' : ''}`, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify(input), signal: AbortSignal.timeout(70_000)}, fetcher);
  let result = await request();
  if (result.response.status === 401 && !configuredToken) {token = await accessToken(api, token, fetcher);result = await request();}
  if (result.response.status === 401) throw new CliError('AUTH_REQUIRED', 'Sign in with opencrawl login, or configure your self-hosted search token.', 2);
  if (result.response.status === 403) throw new CliError('SEARCH_FORBIDDEN', 'This credential cannot search the selected workspace.', 2);
  if (result.response.status === 400) throw new CliError('INVALID_QUERY', 'Invalid query, filters or expired cursor. Run opencrawl search --help.', 64);
  if (result.response.status === 404) throw new CliError('NOT_FOUND', 'Passage not found or no longer available.');
  if (result.response.status === 409) throw new CliError('CONTENT_CHANGED', 'Passage changed. Fetch again from offset 0 without --content-version.');
  if (!result.response.ok) throw new CliError('SEARCH_UNAVAILABLE', 'Workspace search is unavailable on this deployment.');
  const data = result.body.data;
  const valid = operation === 'search'
    ? Array.isArray(data?.results) && Array.isArray(data?.coverage) && typeof data.partial === 'boolean'
    : data?.id === input.id && typeof data?.text === 'string' && typeof data?.version === 'string' && Number.isInteger(data?.offset) && Number.isInteger(data?.totalChars) && (data?.nextOffset === null || Number.isInteger(data?.nextOffset));
  if (result.body.schemaVersion !== 1 || !valid) throw new CliError('INVALID_RESPONSE', 'The service returned an invalid search response.');
  return data;
}
export const searchWorkspace = (api: string, input: Record<string, unknown>, fetcher = fetch) => workspaceRequest(api, 'search', input, fetcher);
export const fetchWorkspace = (api: string, input: Record<string, unknown>, fetcher = fetch) => workspaceRequest(api, 'fetch', input, fetcher);

export function searchInput(query: string | undefined, values: Record<string, unknown>) {
  const source = values.source ?? 'all', match = values.match ?? 'any', limit = Number(values.limit ?? 10), sessionId = values['session-id'], cursor = values.cursor;
  if (!query?.trim() || query.length > 4000 || !['all','sessions','connectors','memories'].includes(source as string) || !['all','any','phrase'].includes(match as string) || !Number.isInteger(limit) || limit < 1 || limit > 40 || (sessionId !== undefined && (source !== 'sessions' || typeof sessionId !== 'string' || !sessionId || sessionId.length > 200)) || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048))) throw new CliError('INVALID_USAGE', 'Use search "words" [--source all|sessions|connectors|memories] [--match any|all|phrase] [--limit 1..40] [--session-id ID] [--cursor TOKEN].', 64);
  return {query: query.trim(), source, match, limit, ...(values['no-dedupe'] ? {dedupe:false} : {}), ...(sessionId ? {sessionId} : {}), ...(cursor ? {cursor} : {})};
}

export function fetchInput(id: string | undefined, values: Record<string, unknown>) {
  const offset = Number(values.offset ?? 0), length = Number(values.length ?? 6000), version = values['content-version'];
  if (!id || !/^(sessions|connectors|memories):[A-Za-z0-9_:-]{1,256}$/.test(id) || !Number.isInteger(offset) || offset < 0 || offset > 10_000_000 || !Number.isInteger(length) || length < 1 || length > 16000 || (version !== undefined && (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)))) throw new CliError('INVALID_USAGE', 'Use fetch ID [--offset N] [--length 1..16000] [--content-version VERSION].', 64);
  return {id, offset, length, ...(version ? {version} : {})};
}

export function formatFetch(data: any): string {
  return [`[${data.id}] ${data.title}`, JSON.stringify(data.provenance), data.url, data.text,
    `Characters ${data.offset}–${data.offset + data.text.length} of ${data.totalChars}.`,
    data.nextOffset !== null ? `Continue: opencrawl fetch ${data.id} --offset ${data.nextOffset} --content-version ${data.version}` : 'End of indexed passage.'].filter(Boolean).join('\n');
}

export function formatSearch(data: any): string {
  const text = data.results.map((r: any) => `[${r.id}] ${r.title}\n${JSON.stringify(r.provenance)}\n${r.url ? r.url + '\n' : ''}${r.excerpt?.start > 0 ? '…' : ''}${r.text}${r.excerpt?.end < r.excerpt?.totalChars ? '…' : ''}${r.duplicateCount ? `\n${r.duplicateCount} additional equivalent passages grouped.` : ''}`).join('\n\n');
  return [text || 'No matching indexed passages.', `Coverage: ${data.coverage.map((c: any) => `${c.source}=${c.state}${c.truncated ? ' (bounded)' : ''}`).join(', ')}`,
    data.results.length ? 'Read more: opencrawl fetch <result-id>. Use --no-dedupe to inspect every occurrence.' : '',
    data.next ? `Next cursor: ${data.next}` : '', data.windowExhausted ? 'Candidate window exhausted. Narrow the query or source to explore further.' : '', data.partial ? 'Some sources could not be searched. These results are incomplete.' : ''].filter(Boolean).join('\n\n');
}
