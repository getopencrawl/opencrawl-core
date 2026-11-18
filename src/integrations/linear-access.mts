import type {Proxy, ProxyRequest, ProxyResponse} from './types.mjs';
import {LINEAR_API, LINEAR_KINDS, linearQueryStream, linearRecordPath} from './linear-upstream.mjs';
export {LINEAR_API} from './linear-upstream.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function linearId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Invalid Linear identity');
}
type Row = Record<string, unknown>;
interface GraphError {message?: string; extensions?: {code?: string}; path?: Array<string | number>}
interface GraphResponse<T> {data?: T; errors?: GraphError[]}
// Linear returns INPUT_ERROR for some archived/deleted singular resources.
// Only its exact missing-entity response is a denial; other input errors still fail.
const missingResource = (error: GraphError, field: string) => error.extensions?.code === 'ENTITY_NOT_FOUND' ||
  error.extensions?.code === 'INPUT_ERROR' && error.message === 'Entity not found: ' + field[0].toUpperCase() + field.slice(1);
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const name = (value: unknown) => typeof value === 'string' ? value : '';
export interface LinearContext {title?: string; url?: string; lines: string[]}
export interface LinearAccess {
  inspect(sourceId: string): Promise<boolean>;
  describeMany(sourceIds: string[]): Promise<Map<string, LinearContext>>;
}
export async function linearQuery<T>(request: Proxy, query: string, variables: Row = {}): Promise<T> {
  const response = await request<GraphResponse<T>>({endpoint: LINEAR_API, method: 'POST', headers: {'Content-Type': 'application/json'}, body: {query, variables}});
  if (response.status !== 200 || response.data?.errors?.length || !response.data?.data) throw new Error('Linear read failed');
  return response.data.data;
}
export function linearUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid Linear resource URL');
  return url.href;
}

const teamFields = 'id name visibility organization { id }';
const issueFields = `id identifier title url trashed team { ${teamFields} }`;
const projectFields = `id name url trashed teams(first: 250, includeArchived: true) { nodes { ${teamFields} } pageInfo { hasNextPage } }`;
const initiativeFields = 'id name url trashed visibility organization { id }';
const fields: Record<string, {query: string; select: string}> = {
  issue: {query: 'issue', select: `${issueFields} state { name type } assignee { name } priorityLabel`},
  comment: {query: 'comment', select: `id url user { name } issue { ${issueFields} }`},
  team: {query: 'team', select: teamFields},
  user: {query: 'user', select: 'id name url'},
  cycle: {query: 'cycle', select: `id name number team { ${teamFields} }`},
  workflow_state: {query: 'workflowState', select: `id name team { ${teamFields} }`},
  issue_label: {query: 'issueLabel', select: `id name team { ${teamFields} }`},
  project: {query: 'project', select: `${projectFields} status { name } lead { name }`},
  project_update: {query: 'projectUpdate', select: `id url user { name } project { ${projectFields} }`},
  project_milestone: {query: 'projectMilestone', select: `id name project { ${projectFields} }`},
  project_status: {query: 'projectStatus', select: 'id name'},
  attachment: {query: 'attachment', select: `id title url issue { ${issueFields} }`},
  issue_relation: {query: 'issueRelation', select: `id type issue { ${issueFields} } relatedIssue { ${issueFields} }`},
  customer: {query: 'customer', select: 'id name url'},
  customer_need: {query: 'customerNeed', select: `id url customer { name } issue { ${issueFields} } project { ${projectFields} }`},
  customer_status: {query: 'customerStatus', select: 'id name'},
  customer_tier: {query: 'customerTier', select: 'id name'},
  initiative: {query: 'initiative', select: initiativeFields},
  initiative_to_project: {query: 'initiativeToProject', select: `id initiative { ${initiativeFields} } project { ${projectFields} }`},
};

/** Visibility belongs to OpenCrawl; extraction, pagination and state belong to Airbyte. */
export function createLinearAccess({tenantId, connectionId, workspaceId, request}: {tenantId: string; connectionId: string; workspaceId: string; request: Proxy}) {
  linearId(workspaceId);
  if (!tenantId || !connectionId) throw new Error('Linear scope required');
  const publicTeam = (value: unknown) => {const t = row(value); return t.visibility === 'public' && row(t.organization).id === workspaceId;};
  const publicIssue = (value: unknown) => {const i = row(value); return Boolean(i.id && (i.trashed === false || i.trashed === null) && publicTeam(i.team));};
  const publicProject = (value: unknown) => {
    const p = row(value), teams = row(p.teams);
    // Never infer visibility from a truncated or malformed team list.
    return Boolean(p.id && (p.trashed === false || p.trashed === null) && row(teams.pageInfo).hasNextPage === false &&
      Array.isArray(teams.nodes) && teams.nodes.length > 0 && teams.nodes.every(publicTeam));
  };
  const publicInitiative = (value: unknown) => {const i = row(value); return Boolean(i.id && i.visibility === 'public' && row(i.organization).id === workspaceId && (i.trashed === false || i.trashed === null));};
  function allowed(kind: string, v: Row): boolean {
    switch (kind) {
      case 'issue': return publicIssue(v);
      case 'comment': case 'attachment': return publicIssue(v.issue);
      case 'issue_relation': return publicIssue(v.issue) && publicIssue(v.relatedIssue);
      case 'team': return publicTeam(v);
      case 'cycle': case 'workflow_state': return publicTeam(v.team);
      case 'issue_label': return v.team === null || publicTeam(v.team);
      case 'project': return publicProject(v);
      case 'project_update': case 'project_milestone': return publicProject(v.project);
      case 'customer_need': return Boolean((v.issue || v.project) && (!v.issue || publicIssue(v.issue)) && (!v.project || publicProject(v.project)));
      case 'initiative': return publicInitiative(v);
      case 'initiative_to_project': return publicInitiative(v.initiative) && publicProject(v.project);
      // These are organization-wide references, explicitly shared by the administrator.
      case 'user': case 'project_status': case 'customer': case 'customer_status': case 'customer_tier': return Boolean(v.id);
      default: return false;
    }
  }
  function context(v: Row): LinearContext {
    const issue = row(v.issue), project = row(v.project), initiative = row(v.initiative);
    const issueTitle = (i: Row) => [name(i.identifier), name(i.title)].filter(Boolean).join(': ');
    const title = issueTitle(v) || name(v.name) || issueTitle(issue) || name(project.name) || name(initiative.name);
    const lines: string[] = [];
    for (const [label, value] of [['Status', row(v.state).name || row(v.status).name], ['Assignee', row(v.assignee).name],
      ['Priority', v.priorityLabel], ['Author', row(v.user).name], ['Lead', row(v.lead).name], ['Team', row(v.team).name],
      ['Issue', issueTitle(issue)], ['Project', project.name], ['Initiative', initiative.name], ['Customer', row(v.customer).name],
      ['Relationship', v.type], ['Related issue', issueTitle(row(v.relatedIssue))]]) {
      if (typeof value === 'string' && value) lines.push(`${label}: ${value}`);
    }
    return {title, url: name(v.url) || name(issue.url) || name(project.url) || name(initiative.url), lines};
  }
  async function organization() {
    const result = await linearQuery<{organization: {id: string}}>(request, 'query OpenCrawlOrganization { organization { id } }');
    if (result.organization?.id !== workspaceId) throw new Error('Linear workspace changed');
  }
  function identity(sourceId: string) {
    const [kind, id, historyId, extra] = sourceId.split(':');
    if (!Object.values(LINEAR_KINDS).includes(kind) || extra !== undefined || (kind === 'issue_history') !== (historyId !== undefined)) throw new Error('Invalid Linear resource');
    linearId(id); if (historyId !== undefined) linearId(historyId);
    return {kind, id, historyId};
  }
  async function history(issueId: string, wanted: Set<string>): Promise<Map<string, LinearContext>> {
    const result = new Map<string, LinearContext>(), seen = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 1000; page++) {
      const response = await request<GraphResponse<{issue: Row}>>({endpoint: LINEAR_API, method: 'POST', headers: {'Content-Type': 'application/json'}, body: {query: `query OpenCrawlHistoryAccess($id: String!, $after: String) { issue(id: $id) { ${issueFields} history(first: 250, after: $after, includeArchived: true) { nodes { id } pageInfo { hasNextPage endCursor } } } }`, variables: {id: issueId, after}}});
      if (response.status === 200 && response.data.errors?.length && response.data.errors.every(e => missingResource(e, 'issue') && e.path?.[0] === 'issue')) return new Map();
      if (response.status !== 200 || response.data.errors?.length || !response.data.data) throw new Error('Linear history access failed');
      const data = response.data.data;
      if (!publicIssue(data.issue)) return new Map();
      const h = row(data.issue.history), info = row(h.pageInfo);
      if (!Array.isArray(h.nodes) || typeof info.hasNextPage !== 'boolean') throw new Error('Invalid Linear history access');
      for (const entry of h.nodes) {const id = name(row(entry).id); if (wanted.has(id)) result.set(`issue_history:${issueId}:${id}`, context(data.issue));}
      if (!info.hasNextPage || result.size === wanted.size) return result;
      const next = name(info.endCursor); if (!next || seen.has(next)) throw new Error('Linear history pagination did not advance');
      seen.add(next); after = next;
    }
    throw new Error('Linear history access exceeded its bound');
  }
  async function describeMany(sourceIds: string[]): Promise<Map<string, LinearContext>> {
    if (sourceIds.length > 100) throw new Error('Linear access batch exceeds 100');
    await organization();
    const result = new Map<string, LinearContext>(), histories = new Map<string, Set<string>>();
    const ordinary = [...new Set(sourceIds)].flatMap(sourceId => {
      const item = identity(sourceId);
      if (item.historyId) {const ids = histories.get(item.id) || new Set<string>(); ids.add(item.historyId); histories.set(item.id, ids); return [];}
      return [{...item, sourceId}];
    });
    // Project visibility expands up to 250 teams. Twelve project aliases exceeded
    // Linear's live query-complexity limit; keep at most five in one request while
    // retaining twenty aliases for inexpensive reads and checking every team.
    const cost = (kind: string) => ['project', 'project_update', 'project_milestone', 'customer_need', 'initiative_to_project'].includes(kind) ? 4 : 1;
    for (let offset = 0; offset < ordinary.length;) {
      let end = offset, budget = 0;
      while (end < ordinary.length && budget + cost(ordinary[end].kind) <= 20) budget += cost(ordinary[end++].kind);
      const batch = ordinary.slice(offset, end), variables = Object.fromEntries(batch.map((item, i) => ['id' + i, item.id]));
      offset = end;
      const query = `query OpenCrawlAccess(${batch.map((_, i) => `$id${i}: String!`).join(', ')}) { ${batch.map((item, i) => `r${i}: ${fields[item.kind].query}(id: $id${i}) { ${fields[item.kind].select} }`).join(' ')} }`;
      const response = await request<GraphResponse<Record<string, Row | null>>>({endpoint: LINEAR_API, method: 'POST', headers: {'Content-Type': 'application/json'}, body: {query, variables}});
      if (response.status !== 200) throw new Error('Linear access failed');
      if (response.data.errors?.length) {
        // A deleted non-null singular field can null the entire batch. Retry only
        // unaffected aliases so one deletion cannot silently discard valid records.
        if (response.data.errors.every(e => {
          const alias = e.path?.[0], item = typeof alias === 'string' && /^r\d+$/.test(alias) ? batch[Number(alias.slice(1))] : undefined;
          return Boolean(item && missingResource(e, fields[item.kind].query));
        })) {
          const missing=new Set(response.data.errors.map(e=>e.path?.[0]));
          if([...missing].some(alias=>typeof alias!=='string'||!/^r\d+$/.test(alias)||Number(alias.slice(1))>=batch.length))throw new Error('Unattributed Linear access failure');
          const remaining=batch.filter((_,i)=>!missing.has('r'+i));
          if(remaining.length===batch.length)throw new Error('Linear access failure did not identify a resource');
          if(remaining.length)for(const [key,value]of await describeMany(remaining.map(item=>item.sourceId)))result.set(key,value);
          continue;
        }
        throw new Error('Linear access failed');
      }
      if (!response.data.data) throw new Error('Incomplete Linear access response');
      for (const [i, item] of batch.entries()) {
        const value = response.data.data['r' + i];
        if (value?.id === item.id && allowed(item.kind, value)) result.set(item.sourceId, context(value));
      }
    }
    for (const [id, wanted] of histories) for (const [key, value] of await history(id, wanted)) result.set(key, value);
    return result;
  }
  return {
    describeMany,
    async inspect(sourceId: string) {return (await describeMany([sourceId])).has(sourceId);},
    /** Only the exact read operations shipped by upstream may use a source capability. */
    async read({endpoint, method, query = {}, headers = {}, body}: ProxyRequest): Promise<ProxyResponse<unknown>> {
      const input = row(body), stream = linearQueryStream(input.query), variables = row(input.variables);
      if (endpoint !== LINEAR_API || method !== 'POST' || Object.keys(query).length || Object.keys(headers).length || !stream ||
        Object.keys(input).some(key => !['query', 'variables'].includes(key)) || Object.keys(variables).some(key => !['after', 'filter', 'orderBy', 'issueId'].includes(key))) throw new Error('Unsupported Linear source request');
      if (variables.after != null && (typeof variables.after !== 'string' || variables.after.length > 2000)) throw new Error('Invalid Linear cursor');
      if (variables.orderBy != null && variables.orderBy !== 'updatedAt') throw new Error('Invalid Linear ordering');
      if (variables.issueId !== undefined) {if (stream !== 'issue_history') throw new Error('Invalid Linear partition'); linearId(variables.issueId);}
      if (variables.filter !== undefined) {
        const filter = row(variables.filter), updated = row(filter.updatedAt);
        if (Object.keys(filter).length !== 1 || Object.keys(updated).length !== 1 || typeof updated.gte !== 'string' || !Number.isFinite(Date.parse(updated.gte))) throw new Error('Invalid Linear incremental cursor');
      }
      await organization();
      const response = await request<GraphResponse<unknown>>({endpoint: LINEAR_API, method: 'POST', headers: {'Content-Type': 'application/json'}, body});
      // Upstream must see errors as failures even when Linear also returns partial data.
      if (response.data?.errors?.length) return {...response, data: {...response.data, data: null}};
      if(response.status===200){
        const path=linearRecordPath(stream),last=path.pop()!;
        let container:Row=row(response.data);
        for(const part of path)container=row(container[part]);
        const nodes=container[last];
        if(!Array.isArray(nodes)||nodes.length>250)throw new Error('Invalid Linear source page');
        const identities=nodes.map(value=>{
          const id=row(value).id;linearId(id);
          return stream==='issue_history'?`issue_history:${variables.issueId}:${id}`:`${LINEAR_KINDS[stream]}:${id}`;
        });
        const allowed=await describeMany(identities);
        // Preserve the original cursor even when every row is excluded.
        container[last]=nodes.filter((_,i)=>allowed.has(identities[i]));
      }
      return response;
    },
  };
}

// Preserve the published factory name; both exports use this single permission adapter.
export {createLinearAccess as createLinearSource};
