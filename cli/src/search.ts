import {CliError, jsonRequest} from './oauth.ts';
import {accessToken} from './session.ts';
import {configuredToken, workspaceIdentityEnabled} from './workspace-identity.ts';

async function workspaceRequest(api: string, operation: 'search' | 'fetch', input: Record<string, unknown>, fetcher = fetch, pinnedToken?:string) {
  const configured = pinnedToken ?? await configuredToken('OPENCRAWL_TOKEN', api);
  let token = configured || await accessToken(api, undefined, fetcher);
  const request = () => jsonRequest(`${api}/api/search${operation === 'fetch' ? '/fetch' : ''}`, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify(input), signal: AbortSignal.timeout(70_000)}, fetcher);
  let result = await request();
  if (result.response.status === 401 && !pinnedToken && (!configured || workspaceIdentityEnabled())) {token = await configuredToken('OPENCRAWL_TOKEN', api, token) || await accessToken(api, token, fetcher);result = await request();}
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
  if (operation === 'fetch' && (input.context || input.before !== undefined || input.after !== undefined) &&
      (!data.context || !Array.isArray(data.context.before) || !Array.isArray(data.context.after)))
    throw new CliError('CONTEXT_UNAVAILABLE', 'This server did not return event context. Upgrade the server or fetch the passage without --context.');
  return data;
}
// An import binds identity and every passage read to the same authenticated credential.
export const memoryReader = (api:string,token:string) => ({
  search:(input:Record<string,unknown>)=>workspaceRequest(api,'search',input,fetch,token),
  fetch:(input:Record<string,unknown>)=>workspaceRequest(api,'fetch',input,fetch,token),
});
export const searchWorkspace = (api: string, input: Record<string, unknown>, fetcher = fetch) => workspaceRequest(api, 'search', input, fetcher);
export const fetchWorkspace = (api: string, input: Record<string, unknown>, fetcher = fetch) => workspaceRequest(api, 'fetch', input, fetcher);

// Date-only flags name whole UTC days. Timestamps retain their explicit offset.
function searchBound(value: unknown, key: 'after' | 'before'): string {
  const invalid = () => new CliError('INVALID_USAGE', 'Use a UTC date (YYYY-MM-DD) or an ISO timestamp with timezone for '+key+'.', 64);
  if (typeof value !== 'string') throw invalid();
  const day = value.slice(0, 10);
  const midnight = new Date(day+'T00:00:00Z');
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== day) throw invalid();
  if (value === day) return day+(key === 'after' ? 'T00:00:00.000Z' : 'T23:59:59.999Z');
  if (!/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw invalid();
  return value;
}

export function searchInput(query: string | undefined, values: Record<string, unknown>) {
  const source = values.source ?? 'all', match = values.match ?? 'any', limit = Number(values.limit ?? 10), sessionId = values['session-id'], cursor = values.cursor;
  const order=values.order;
  if (query?.trim() && (order === 'newest' || order === 'oldest'))
    throw new CliError('INVALID_USAGE','Keyword search ranks by relevance. Use --after/--before for a time window, or opencrawl browse for a timeline.',64);
  if ((!query?.trim()&&!['newest','oldest'].includes(String(order))) || (query?.length??0) > 4000 || !['all','sessions','connectors','memories'].includes(source as string) || !['all','any','phrase'].includes(match as string) || !Number.isInteger(limit) || limit < 1 || limit > 40 || (sessionId !== undefined && (source !== 'sessions' || typeof sessionId !== 'string' || !sessionId || sessionId.length > 200)) || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048)) || order!==undefined&&!['relevance','newest','oldest'].includes(String(order))) throw new CliError('INVALID_USAGE', 'Use search "keywords" --match all. See opencrawl --help for filters, projections and browsing.', 64);
  let filters:Record<string,unknown>={};
  if(values.filters!==undefined){try{filters=JSON.parse(String(values.filters));}catch{throw new CliError('INVALID_USAGE','--filters requires a JSON object.',64);}}
  if(!filters||typeof filters!=='object'||Array.isArray(filters))throw new CliError('INVALID_USAGE','--filters requires a JSON object.',64);
  for (const [key, alias] of [['after','since'],['before','until']] as const) {
    const bounds = [filters[key], values[key], values[alias]].filter(value => value !== undefined).map(value => searchBound(value, key));
    if (!bounds.length) continue;
    const [first] = bounds;
    if (bounds.some(bound => Date.parse(bound) !== Date.parse(first)))
      throw new CliError('INVALID_USAGE','Conflicting '+key+' bounds. Use one value across --filters, --'+key+' and --'+alias+'.',64);
    filters[key] = first;
  }
  if(values.role!==undefined)filters.roles=[values.role];
  const arrays=['authors','kinds','excludeKinds','roles','harnesses','origins','clientApps','sessionIds','providers','repositories','projects','paths','toolNames'];
  for(const [key,value] of Object.entries(filters)){
    const valid=arrays.includes(key)?Array.isArray(value)&&value.length>0&&value.length<=20&&value.every(x=>typeof x==='string'&&x.length>0&&x.length<=(key==='sessionIds'?200:500)):
      ['after','before'].includes(key);
    if(!valid)throw new CliError('INVALID_USAGE','Invalid search filter '+key+'.',64);
  }
  if(filters.roles&&(!(filters.roles as string[]).every(r=>['user','assistant','system','developer'].includes(r))||(filters.roles as string[]).length>4))throw new CliError('INVALID_USAGE','Invalid roles filter.',64);
  if(filters.after&&filters.before&&Date.parse(String(filters.after))>Date.parse(String(filters.before)))throw new CliError('INVALID_USAGE','after must not exceed before.',64);
  const extra:Record<string,unknown>={};
  if(values['current-session']!==undefined){
    let current:unknown;
    try{current=JSON.parse(String(values['current-session']));}catch{throw new CliError('INVALID_USAGE','--current-session requires {"harness":"codex","sessionId":"native-chat-id"}.',64);}
    if(!current||typeof current!=='object'||Array.isArray(current))throw new CliError('INVALID_USAGE','Invalid --current-session.',64);
    const identity=current as Record<string,unknown>;
    if(Object.keys(identity).some(key=>!['harness','sessionId'].includes(key))||!['codex','claude-code','cursor','antigravity','devin'].includes(String(identity.harness))||typeof identity.sessionId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(identity.sessionId))throw new CliError('INVALID_USAGE','Use the exact native chat ID and harness in --current-session; no user or workspace fields.',64);
    extra.currentSession=identity;
  }
  for(const [flag,key] of [['include-current-session','includeCurrentSession'],['include-tool-outputs','includeToolOutputs']] as const){
    if(values[flag]!==undefined){if(typeof values[flag]!=='boolean')throw new CliError('INVALID_USAGE','Invalid --'+flag+'.',64);extra[key]=values[flag];}
  }
  for(const [flag,key,allowed] of [['select','select',['title','text','url','provenance']],['facets','facets',['source','kind','author','harness','origin','clientApp','provider','repository','project','path','role','sessionId']]] as const){
    if(values[flag]===undefined)continue;const selected=String(values[flag]).split(',').filter(Boolean);
    if(selected.some(v=>!(allowed as readonly string[]).includes(v))||selected.length>allowed.length)throw new CliError('INVALID_USAGE','Invalid --'+flag+'.',64);extra[key]=selected;
  }
  if(values['group-by']!==undefined){if(!['none','resource','session'].includes(String(values['group-by'])))throw new CliError('INVALID_USAGE','Invalid --group-by.',64);extra.groupBy=values['group-by'];}
  if(values['excerpt-chars']!==undefined){const n=Number(values['excerpt-chars']);if(!Number.isInteger(n)||n<100||n>2000)throw new CliError('INVALID_USAGE','--excerpt-chars must be 100–2000.',64);extra.excerptChars=n;}
  return {query:query?.trim()||'',source,match,limit,...(values['no-dedupe']?{dedupe:false,groupBy:'none'}:{}),...(sessionId?{sessionId}:{}),...(cursor?{cursor}:{}),...(order?{order}:{}),...(Object.keys(filters).length?{filters}:{}),...extra};
}

export function fetchInput(id: string | undefined, values: Record<string, unknown>) {
  const offset = Number(values.offset ?? 0), length = Number(values.length ?? 6000), version = values['content-version'];
  if (!id || !/^(sessions|connectors|memories):[A-Za-z0-9_:-]{1,256}$/.test(id) || !Number.isInteger(offset) || offset < 0 || offset > 10_000_000 || !Number.isInteger(length) || length < 1 || length > 16000 || (version !== undefined && (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)))) throw new CliError('INVALID_USAGE', 'Use fetch ID [--offset N] [--length 1..16000] [--content-version VERSION].', 64);
  const context = values.context === true || values.before !== undefined || values.after !== undefined;
  if (context && (!id.startsWith('sessions:') || values.context === false) || !context && values['include-tool-outputs'] !== undefined)
    throw new CliError('INVALID_USAGE', 'Event context requires a sessions: result ID and --context, --before or --after.', 64);
  const before = Number(values.before ?? 3), after = Number(values.after ?? 3);
  if (context && ![before, after].every(n => Number.isInteger(n) && n >= 0 && n <= 10))
    throw new CliError('INVALID_USAGE', 'Use --before 0..10 and --after 0..10 for neighboring events.', 64);
  return {id, offset, length, ...(version ? {version} : {}), ...(context ? {context: true, before, after, includeToolOutputs: values['include-tool-outputs'] === true} : {})};
}

export function formatFetch(data: any): string {
  if (data.context) {
    const event = (item: any) => [`[${item.id}] ${item.provenance.role || item.provenance.kind}${item.provenance.timestamp ? ' at ' + item.provenance.timestamp : ''}`,
      item.text, !item.eventTextComplete ? `Event excerpt. Read more: opencrawl fetch ${item.id}` : ''].filter(Boolean).join('\n');
    return [`Event context: tool outputs ${data.context.toolOutputsIncluded ? 'included' : 'excluded from neighbors'}. Selected passage is always included.`,
      data.context.warning, ...data.context.before.map(event), 'Selected passage:', formatFetch({...data, context: undefined}), ...data.context.after.map(event),
      data.context.moreBefore ? 'Earlier events are available; center --context on an earlier event ID.' : 'Start of matching session events.',
      data.context.moreAfter ? 'Later events are available; center --context on a later event ID.' : 'End of matching session events.'].filter(Boolean).join('\n\n');
  }
  return [`[${data.id}] ${data.title}`, JSON.stringify(data.provenance), data.url, data.text,
    `Characters ${data.offset}–${data.offset + data.text.length} of ${data.totalChars}.`,
    data.nextOffset !== null ? `Continue: opencrawl fetch ${data.id} --offset ${data.nextOffset} --content-version ${data.version}` : 'End of indexed passage.',
    data.nextId?`Next passage: opencrawl fetch ${data.nextId}`:'',data.previousId?`Previous passage: opencrawl fetch ${data.previousId}`:''].filter(Boolean).join('\n');
}

export function formatSearch(data: any): string {
  const context=data.searchContext;
  const defaults=context?`Search scope: tool outputs ${context.toolOutputsIncluded?'included':'excluded (use --include-tool-outputs for execution evidence)'}; current chat ${context.currentSessionStatus==='excluded'?'excluded (use --include-current-session to include it)':context.currentSessionStatus==='included'?'included by request':'not excluded: native identity unavailable (supply --current-session)'}.`:'';
  const text = data.results.map((r: any) => [`[${r.id}]${r.title?' '+r.title:''}`,r.provenance?JSON.stringify(r.provenance):'',r.url,
    r.text!==undefined?`${r.excerpt?.start>0?'…':''}${r.text}${r.excerpt?.end<r.excerpt?.totalChars?'…':''}`:'',
    r.duplicateCount?`${r.duplicateCount} additional equivalent passages grouped.`:'',r.groupedCount?`${r.groupedCount} other passages in this resource.`:''].filter(Boolean).join('\n')).join('\n\n');
  return [defaults, context?.warning, text || 'No matching indexed passages.', `Coverage: ${data.coverage.map((c: any) => `${c.source}=${c.state}${c.truncated ? ' (bounded)' : ''}`).join(', ')}`,
    data.facets?`Facets (${data.facetScope}): ${JSON.stringify(data.facets)}`:'',
    data.results.length ? 'Read more: opencrawl fetch <result-id>. Use --group-by none --no-dedupe to inspect every occurrence.' : '',
    data.next ? `Next cursor: ${data.next}` : '', data.windowExhausted ? 'Candidate window exhausted. Narrow the query or source to explore further.' : '', data.partial ? 'Some sources could not be searched. These results are incomplete.' : ''].filter(Boolean).join('\n\n');
}
