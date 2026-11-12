import {z} from 'zod';
import type {Corpus} from './types.mjs';
import {realmField} from './realm.mjs';

const values = z.array(z.string().min(1).max(500)).min(1).max(20);
const instant = z.iso.datetime({offset:true});
export const searchFiltersSchema = z.strictObject({
  authors: values.optional().describe('Exact author/user IDs from result provenance.'),
  kinds: values.optional().describe('Exact record kinds; e.g. message, tool_result, commit, passage.'),
  excludeKinds: values.optional(),
  roles: z.array(z.enum(['user','assistant','system','developer'])).min(1).max(4).optional().describe('Session message roles; excludes other sources and records without this role.'),
  harnesses: values.optional(), origins: values.optional().describe('Exact recorded session origins from provenance/facets: cli, desktop, cloud, subagent or unknown. An origin is not an authority or quality label.'), providers: values.optional(), repositories: values.optional(),
  sessionIds: z.array(z.string().min(1).max(200)).min(1).max(20).optional().describe('Search any of these exact session IDs from provenance/facets. Other filters and any top-level sessionId still intersect this set; access checks remain unchanged.'),
  projects: values.optional(), paths: values.optional(), toolNames: values.optional(),
  after: instant.optional(), before: instant.optional(),
}).refine(f=>!f.after||!f.before||Date.parse(f.after)<=Date.parse(f.before),'after must not exceed before');
export type SearchFilters = z.infer<typeof searchFiltersSchema>;
export type SearchOrder = 'relevance' | 'newest' | 'oldest';

/** Filters add constraints inside each source's existing authorization query. */
export function searchFilters(corpus: Corpus, input: SearchFilters = {}): unknown[] {
  const parsed=searchFiltersSchema.safeParse(input);
  if(!parsed.success)throw Object.assign(new Error('Invalid search filters'),{status:400});
  const f=parsed.data, field=(key:string)=>realmField(corpus,key), clauses: unknown[]=[];
  const terms=(key:string,v:string[]|undefined)=>{if(v)clauses.push({terms:{[key]:v}});};
  terms(corpus==='connector'?field('authorId'):field('userId'),f.authors);
  terms(field('kind'),f.kinds);
  if(f.excludeKinds)clauses.push({bool:{must_not:[{terms:{[field('kind')]:f.excludeKinds}}]}});
  for(const [key,value,allowed] of [
    ['sessionId',f.sessionIds,['session']],
    ['role',f.roles,['session']],['origin',f.origins,['session']],['harness',f.harnesses,['session','memory']],
    ['provider',f.providers,['connector']],['repository',f.repositories,['connector']],
    ['project',f.projects,['memory']],['path',f.paths,['memory']],['toolNames',f.toolNames,['session']],
  ] as const)if(value){if(!allowed.some(c=>c===corpus))clauses.push({match_none:{}});else terms(field(key),value);}
  // Never substitute upload time for the time of an agent message or memory.
  const time=corpus==='session'?field('timestamp'):corpus==='memory'?field('modifiedAt'):'timestamp';
  // Numeric instants prevent engine date parsing from widening omitted fractions.
  if(f.after||f.before)clauses.push({range:{[time]:{...(f.after?{gte:Date.parse(f.after)}:{}),...(f.before?{lte:Date.parse(f.before)}:{})}}});
  return clauses;
}
export function searchSort(corpus: Corpus, order: SearchOrder = 'relevance'): unknown[] {
  if(!['relevance','newest','oldest'].includes(order))throw Object.assign(new Error('Invalid search order'),{status:400});
  if(order==='relevance')return [];
  const time=corpus==='session'?realmField(corpus,'timestamp'):corpus==='memory'?realmField(corpus,'modifiedAt'):'timestamp';
  return [{[time]:{order:order==='newest'?'desc':'asc',missing:'_last'}}];
}
