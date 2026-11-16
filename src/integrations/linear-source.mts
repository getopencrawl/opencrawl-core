import type {Proxy, ProxyRequest} from './types.mjs';
import {digest} from '../connectors/scope.mjs';
import {sourcePaginationProgress, advanceSourcePagination, sourcePaginationCheckpoint, type SourceCheckpoint} from '../connectors/workflow.mjs';

export const LINEAR_API = 'https://api.linear.app/graphql';
export const LINEAR_POLICY = 'linear-public-team-v1';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function linearId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Invalid Linear identity');
}
interface Team {id: string; visibility: 'public' | 'private' | 'restricted'; organization: {id: string}}
interface IssueAccess {id: string; trashed: boolean | null; team: Team}
interface IssueSummary extends IssueAccess {identifier: string; title: string}
interface Issue extends IssueSummary {description: string | null; url: string; updatedAt: string}
interface Comment {id: string; body: string; url: string; updatedAt: string; issue: IssueSummary | null}
interface GraphResponse<T> {data?: T; errors?: unknown[]}
const accessFields = 'id trashed team { id visibility organization { id } }';
const issueFields = `identifier title description url updatedAt ${accessFields}`;
const commentFields = `id body url updatedAt issue { identifier title ${accessFields} }`;
export interface LinearDocument extends Record<string, unknown> {
  id: string; kind: 'issue' | 'comment'; title: string; text: string; url: string; updatedAt: string;
  access: {policy: typeof LINEAR_POLICY; tenantId: string; connectionId: string; workspaceId: string; teamId: string; checkedAt: number; contentHash: string};
}
/** Only application-authored read queries reach Linear. Airbyte receives no arbitrary GraphQL capability. */
export async function linearQuery<T>(request: Proxy, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await request<GraphResponse<T>>({endpoint: LINEAR_API, method: 'POST', headers: {'Content-Type': 'application/json'}, body: {query, variables}});
  if (response.status !== 200 || response.data?.errors?.length || !response.data?.data) throw new Error('Linear read failed');
  return response.data.data;
}
function publicIssue(issue: IssueAccess | null, workspaceId: string): issue is IssueAccess {
  return Boolean(issue && issue.team?.visibility === 'public' && issue.team.organization?.id === workspaceId && (issue.trashed === false || issue.trashed === null));
}
export function linearUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'linear.app' || url.username || url.password) throw new Error('Invalid Linear resource URL');
  return value;
}
export function createLinearSource({tenantId, connectionId, workspaceId, request, now = Date.now}: {tenantId: string; connectionId: string; workspaceId: string; request: Proxy; now?: () => number}) {
  linearId(workspaceId);
  if (!tenantId || !connectionId) throw new Error('Linear scope required');
  async function organization() {
    const result = await linearQuery<{organization: {id: string}}>(request, 'query OpenCrawlOrganization { organization { id } }');
    if (result.organization?.id !== workspaceId) throw new Error('Linear workspace changed');
  }
  function document(kind: LinearDocument['kind'], value: Issue | Comment): LinearDocument | null {
    const issue = kind === 'issue' ? value as Issue : (value as Comment).issue;
    if (!publicIssue(issue, workspaceId)) return null;
    linearId(value.id); linearId(issue.team.id);
    if (kind === 'issue' && (value as Issue).description !== null && typeof (value as Issue).description !== 'string') throw new Error('Incomplete Linear issue body');
    const title = `${issue.identifier}: ${issue.title}`, body = kind === 'issue' ? (value as Issue).description ?? '' : (value as Comment).body;
    if (typeof issue.title !== 'string' || typeof issue.identifier !== 'string' || typeof body !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('Invalid Linear content');
    if (Buffer.byteLength(title) + Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('Linear content exceeds 8 MiB');
    const fields = {id: `${kind}:${value.id}`, kind, title, text: body, url: linearUrl(value.url), updatedAt: value.updatedAt};
    return {...fields, access: {policy: LINEAR_POLICY, tenantId, connectionId, workspaceId, teamId: issue.team.id, checkedAt: now(), contentHash: digest(fields)}};
  }
  return {
    async read({endpoint, method = 'GET', query = {}, headers = {}, body}: ProxyRequest) {
      const stream = endpoint === 'opencrawl://linear/issues' ? 'issues' : endpoint === 'opencrawl://linear/comments' ? 'comments' : null;
      if (!stream || method !== 'GET' || body !== undefined || Object.keys(headers).length || Object.keys(query).some(key => key !== 'pageToken')) throw new Error('Unsupported Linear source request');
      let position: {stream: string; workspaceId: string; token: string; progress?: SourceCheckpoint} | undefined;
      if (query.pageToken !== undefined) {
        if (typeof query.pageToken !== 'string' || !/^[A-Za-z0-9_-]{1,8192}$/.test(query.pageToken)) throw new Error('Invalid Linear cursor');
        position = JSON.parse(Buffer.from(query.pageToken, 'base64url').toString());
        if (!position || position.stream !== stream || position.workspaceId !== workspaceId || typeof position.token !== 'string' || !position.token || position.token.length > 2000) throw new Error('Invalid Linear cursor scope');
      }
      const after = position?.token;
      const progress = sourcePaginationProgress(after ?? null, position?.progress);
      await organization();
      const result = await linearQuery<Record<string, {nodes: Array<Issue | Comment>; pageInfo: {hasNextPage: boolean; endCursor: string | null}}>>(request,
        `query OpenCrawlPage($after: String) { ${stream}(first: 50, after: $after, includeArchived: true) { nodes { ${stream === 'issues' ? issueFields : commentFields} } pageInfo { hasNextPage endCursor } } }`, {after: after ?? null});
      const page = result[stream];
      if (!page || !Array.isArray(page.nodes) || page.nodes.length > 50 || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('Invalid Linear page');
      const cursor = page.pageInfo.endCursor;
      if (page.pageInfo.hasNextPage && (typeof cursor !== 'string' || !cursor || cursor === after || cursor.length > 2000)) throw new Error('Linear pagination did not advance');
      const documents = page.nodes.flatMap(value => {const item = document(stream === 'issues' ? 'issue' : 'comment', value); return item ? [item] : [];});
      const next = advanceSourcePagination(progress, {keys: [], cursor: page.pageInfo.hasNextPage ? cursor : null});
      const nextPageToken = next ? Buffer.from(JSON.stringify({stream, workspaceId, token: cursor, progress: sourcePaginationCheckpoint(next)})).toString('base64url') : undefined;
      return {status: 200, data: {documents, ...(nextPageToken ? {nextPageToken} : {})}};
    },
    /** Fail closed for deleted resources, private teams, moved issues and changed workspaces. */
    async inspect(sourceId: string) {
      const [kind, id, extra] = sourceId.split(':');
      if (extra !== undefined || !['issue', 'comment'].includes(kind)) return false;
      linearId(id);
      await organization();
      const result = await linearQuery<Record<string, (IssueAccess & {issue?: IssueAccess | null}) | null>>(request,
        `query OpenCrawlResource($id: String!) { ${kind}(id: $id) { ${kind === 'issue' ? accessFields : `id issue { ${accessFields} }`} } }`, {id});
      const value = result[kind];
      if (!value || value.id !== id) return false;
      return publicIssue(kind === 'issue' ? value : value.issue ?? null, workspaceId);
    },
  };
}
