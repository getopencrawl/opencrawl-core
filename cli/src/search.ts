import {CliError, jsonRequest} from './oauth.ts';
import {accessToken} from './session.ts';

export async function searchWorkspace(api: string, input: Record<string, unknown>, fetcher = fetch) {
  const configuredToken = process.env.OPENCRAWL_TOKEN;
  let token = configuredToken || await accessToken(api, undefined, fetcher);
  const request = () => jsonRequest(`${api}/api/search`, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify(input), signal: AbortSignal.timeout(70_000)}, fetcher);
  let result = await request();
  if (result.response.status === 401 && !configuredToken) {token = await accessToken(api, token, fetcher);result = await request();}
  if (result.response.status === 401) throw new CliError('AUTH_REQUIRED', 'Sign in with opencrawl login, or configure your self-hosted search token.', 2);
  if (result.response.status === 403) throw new CliError('SEARCH_FORBIDDEN', 'This credential cannot search the selected workspace.', 2);
  if (result.response.status === 400) throw new CliError('INVALID_QUERY', 'Invalid query, filters or expired cursor. Run opencrawl search --help.', 64);
  if (!result.response.ok) throw new CliError('SEARCH_UNAVAILABLE', 'Workspace search is unavailable on this deployment.');
  const data = result.body.data;
  if (result.body.schemaVersion !== 1 || !Array.isArray(data?.results) || !Array.isArray(data?.coverage) || typeof data.partial !== 'boolean') throw new CliError('INVALID_RESPONSE', 'The service returned an invalid search response.');
  return data;
}

export function searchInput(query: string | undefined, values: Record<string, unknown>) {
  const source = values.source ?? 'all', match = values.match ?? 'any', limit = Number(values.limit ?? 10), sessionId = values['session-id'], cursor = values.cursor;
  if (!query?.trim() || query.length > 4000 || !['all','sessions','connectors'].includes(source as string) || !['all','any','phrase'].includes(match as string) || !Number.isInteger(limit) || limit < 1 || limit > 40 || (sessionId !== undefined && (source !== 'sessions' || typeof sessionId !== 'string' || !sessionId || sessionId.length > 200)) || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048))) throw new CliError('INVALID_USAGE', 'Use search "words" [--source all|sessions|connectors] [--match any|all|phrase] [--limit 1..40] [--session-id ID] [--cursor TOKEN].', 64);
  return {query: query.trim(), source, match, limit, ...(sessionId ? {sessionId} : {}), ...(cursor ? {cursor} : {})};
}

export function formatSearch(data: any): string {
  const text = data.results.map((r: any) => `[${r.id}] ${r.title}\n${JSON.stringify(r.provenance)}\n${r.url ? r.url + '\n' : ''}${r.text}`).join('\n\n');
  return [text || 'No matching indexed passages.', `Coverage: ${data.coverage.map((c: any) => `${c.source}=${c.state}${c.truncated ? ' (bounded)' : ''}`).join(', ')}`,
    data.next ? `Next cursor: ${data.next}` : '', data.windowExhausted ? 'Candidate window exhausted. Narrow the query or source to explore further.' : '', data.partial ? 'Some sources could not be searched. These results are incomplete.' : ''].filter(Boolean).join('\n\n');
}
