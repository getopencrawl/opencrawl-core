import type {DiagnosticSearch, SearchResponse} from '../pages/types.ts';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};}
function rows(value: unknown): ObjectValue[] {return Array.isArray(value) ? value.map(object) : [];}
function text(value: unknown) {return typeof value === 'string' ? value : '';}

/** Preserve the core runtime's authorized results and per-source coverage for inspection. */
export function workspaceSearchDiagnostics(value: unknown): DiagnosticSearch {
  const data = object(value), results = rows(data.results), coverage = rows(data.coverage);
  const group = (source: string): SearchResponse & {truncated: boolean} => {
    const status = coverage.find(item => item.source === source);
    const hits = results.filter(item => item.source === source).map(item => ({_id:text(item.id), _source:{...object(item.provenance), title:item.title, text:item.text, provenance:item.provenance, passageId:item.id}}));
    return {state:text(status?.state), truncated:Boolean(status?.truncated), hits:{hits,total:{value:hits.length}}};
  };
  const sessions = group('sessions'), connectors = group('connectors');
  return {
    sessions:[{scope:'workspace',response:sessions}],
    connectors:{state:connectors.state,truncated:connectors.truncated,responses:[connectors]},
    ...(coverage.some(item => item.source === 'memories') || results.some(item => item.source === 'memories') ? {memories:group('memories')} : {}),
  };
}
