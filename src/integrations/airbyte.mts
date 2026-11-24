import type {Fetch} from './ports.mjs';
import type {AirbyteResource, AirbyteJob, StreamStats, ConnectorManifest} from './types.mjs';
export interface AirbyteOptions {url: string; clientId: string; clientSecret: string; fetch?: Fetch}
interface Page<T> {data: T[]; next?: string | null}
interface JobStatistics {job: {status: string; streamAggregatedStats?: StreamStats[]}; attempts?: Array<{streamStats?: Array<{streamName: string; stats: Omit<StreamStats, 'streamName'>}>}>}
// Client for an operator-configured Airbyte public API. Source credentials are supplied separately.
// Calls that may run a connector (spec, check, discover) in a pod.
const SLOW = 8 * 60_000;

export function createAirbyteTransport({url, clientId, clientSecret, fetch: fetchImpl = globalThis.fetch}: AirbyteOptions) {
  if (!url || !clientId || !clientSecret) throw new Error('Airbyte URL and API credentials are required');
  const api = `${url.replace(/\/+$/, '')}/api/public/v1`;
  let token: string | null = null, expiresAt = 0, pending: Promise<string> | null = null;

  function accessToken(rejected?: string) {
    // A delayed 401 may refer to a token another request already replaced.
    if (rejected === token) expiresAt = 0;
    if (token && token !== rejected && Date.now() < expiresAt - 60_000) return token;
    pending ||= (async () => {
      const res = await fetchImpl(`${api}/applications/token`, {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({client_id: clientId, client_secret: clientSecret, 'grant-type': 'client_credentials'}), redirect: 'error', signal: AbortSignal.timeout(15000)});
      if (!res.ok) throw new Error(`Airbyte token request failed with ${res.status}`);
      const body = await res.json() as {access_token: string; expires_in?: number};
      token = body.access_token;
      expiresAt = Date.now() + (body.expires_in || 900) * 1000;
      return token;
    })().finally(() => { pending = null; });
    return pending;
  }

  async function request<T>(method: string, path: string, body?: unknown, timeout = 60000): Promise<T> {
    const send = async (bearer: string) => fetchImpl(`${api}${path}`, {method, headers: {
      Authorization: `Bearer ${bearer}`, Accept: 'application/json', ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
    }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeout)});
    const bearer = await accessToken();
    let res = await send(bearer);
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      res = await send(await accessToken(bearer));
    }
    const text = await res.text();
    if (!res.ok) {
      // Destination errors can echo the capability or a source secret. The
      // status is enough to classify an API failure; never propagate its body
      // into application logs or an operator console.
      const error = Object.assign(new Error(`Airbyte ${method} ${path.split('?')[0]} failed with ${res.status}`), {status: res.status});
      throw error;
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  // Live record counts for a running sync exist only on the internal config API (the public
  // API reports rows when a job ends). Read-only and optional: callers fall back without it.
  async function config<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/api/v1${path}`, {method: 'POST', headers: {
      Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', Accept: 'application/json',
    }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000)});
    if (!res.ok) throw new Error(`Airbyte config ${path} failed with ${res.status}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  return {request, config};
}
export function createAirbyte(options: AirbyteOptions) {
  const {request, config} = createAirbyteTransport(options);
  const api = `${options.url.replace(/\/+$/, '')}/api/public/v1`;
  // Recovery must never interpret a malformed, truncated or repeating listing
  // as proof that an earlier create did not happen.
  async function resources(type: 'sources' | 'destinations' | 'connections', workspaceId: string): Promise<AirbyteResource[]> {
    if (typeof workspaceId !== 'string' || !workspaceId) throw new Error('Airbyte workspace is required');
    const data: AirbyteResource[] = [], seen = new Set<string>(), idField = ({sources: 'sourceId', destinations: 'destinationId', connections: 'connectionId'} as const)[type];
    for (let offset = 0; offset < 100_000; offset += 100) {
      const page = await request<Page<AirbyteResource>>('GET', `/${type}?workspaceIds=${encodeURIComponent(workspaceId)}&includeDeleted=false&limit=100&offset=${offset}`);
      if (!Array.isArray(page?.data) || page.data.length > 100) throw new Error('Invalid Airbyte resource listing');
      for (const item of page.data) {
        if (!item || item.workspaceId !== workspaceId || typeof item[idField] !== 'string' || !item[idField]
          || typeof item.name !== 'string' || seen.has(item[idField])) throw new Error('Invalid Airbyte resource listing');
        seen.add(item[idField]!); data.push(item);
      }
      if (page.next !== undefined && page.next !== null && typeof page.next !== 'string') throw new Error('Invalid Airbyte resource listing cursor');
      if (page.next) {
        let next;
        try { next = new URL(page.next, api + '/'); } catch { throw new Error('Invalid Airbyte resource listing cursor'); }
        const expected = {offset: String(offset + 100), limit: '100', workspaceIds: workspaceId, includeDeleted: 'false'};
        if (!page.data.length || next.pathname !== new URL(`${api}/${type}`).pathname
          || Object.entries(expected).some(([key, value]) => next.searchParams.getAll(key).length !== 1 || next.searchParams.get(key) !== value)) {
          throw new Error('Incomplete Airbyte resource listing');
        }
        // Airbyte 2.4 emits a next link even on a short final nonempty page,
        // sometimes with its reverse proxy's origin. Probe the next offset on
        // our pinned API URL and workspace; never fetch the supplied URL.
        continue;
      }
      if (page.data.length < 100) {
        return data;
      }
    }
    throw new Error('Airbyte resource listing exceeded its recovery limit');
  }

  interface BoundJob {jobId:number;connectionId:string;jobType:string;status:string}
  const terminal = (status:string) => ['succeeded','failed','cancelled'].includes(status);
  function boundJob(job:BoundJob,connectionId:string) {
    if (!Number.isSafeInteger(job?.jobId) || job.jobId < 0 || job.connectionId !== connectionId ||
        !['sync','reset','clear','refresh'].includes(job.jobType) ||
        !terminal(job.status) && !['pending','queued','running','incomplete'].includes(job.status)) {
      throw new Error('Airbyte job binding changed');
    }
    return job;
  }
  async function latestJob(connectionId:string, syncOnly=false) {
    const query = new URLSearchParams({connectionId,limit:'1',orderBy:'createdAt|DESC'});
    if (syncOnly) query.set('jobType','sync');
    const page = await request<Page<BoundJob>>('GET','/jobs?'+query);
    if (!Array.isArray(page?.data) || page.data.length > 1 || !page.data.length && page.next) throw new Error('Invalid Airbyte job listing');
    if (!page.data.length) return null;
    const job = boundJob(page.data[0],connectionId);
    if (syncOnly && job.jobType !== 'sync') throw new Error('Airbyte sync job type changed');
    return job;
  }

  return {
    async declarativeSources(workspaceId: string) {
      const page = await request<Page<AirbyteResource>>('GET', `/workspaces/${workspaceId}/definitions/declarative_sources`);
      if (!Array.isArray(page?.data) || page.next || page.data.some(row => typeof row?.name !== 'string')) {
        throw new Error('Incomplete Airbyte definition listing');
      }
      return page.data;
    },
    createDeclarativeSource: (workspaceId: string, name: string, manifest: ConnectorManifest) => request<AirbyteResource>('POST', `/workspaces/${workspaceId}/definitions/declarative_sources`, {name, manifest}),
    // The public PUT edits the definition's Builder project, which API-created definitions don't
    // have (404). Publish a new active manifest version instead, as the Builder's Publish does.
    // A long description (Slack's manifest's own) fails with 409 "Failed to access database".
    async updateDeclarativeSource(workspaceId: string, id: string, manifest: ConnectorManifest) {
      const {manifestVersions = []} = await config<{manifestVersions?: Array<{version: number}>}>('/declarative_source_definitions/list_manifests', {workspaceId, sourceDefinitionId: id}) || {};
      const version = Math.max(0, ...manifestVersions.map(m => m.version)) + 1;
      await config('/declarative_source_definitions/create_manifest', {workspaceId, sourceDefinitionId: id, setAsActiveManifest: true,
        declarativeManifest: {manifest, spec: {connectionSpecification: manifest.spec.connection_specification}, version, description: `OpenCrawl ${new Date().toISOString()}`}});
    },
    sourceDefinitions: (workspaceId: string) => request<Page<AirbyteResource>>('GET', `/workspaces/${workspaceId}/definitions/sources`).then(r => r?.data || []),
    destinations: (workspaceId: string) => resources('destinations', workspaceId),
    sources: (workspaceId: string) => resources('sources', workspaceId),
    connections: (workspaceId: string) => resources('connections', workspaceId),
    resource: (type:'connections'|'sources'|'destinations',id:string) => {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid Airbyte resource ID');
      return request<AirbyteResource>('GET', `/${type}/${id}`);
    },
    destinationDefinitions: (workspaceId: string) => request<Page<AirbyteResource>>('GET', `/workspaces/${workspaceId}/definitions/destinations`).then(r => r?.data || []),
    destinationDefinitionVersion: (actorDefinitionId: string) => config<{
      dockerRepository: string; dockerImageTag: string; supportsRefreshes: boolean; connectorIPCOptions?: unknown;
    }>('/actor_definition_versions/get_default', {actorDefinitionId}),
    createDestinationDefinition: (workspaceId: string, definition: unknown) =>
      request<AirbyteResource>('POST', `/workspaces/${workspaceId}/definitions/destinations`, definition, SLOW),
    createDestination: (destination: object) => request<AirbyteResource & { destinationId: string}>('POST', '/destinations', destination, SLOW),
    deleteDestination: (id: string) => request<void>('DELETE', `/destinations/${id}`),
    createSource: (source: object) => request<AirbyteResource & { sourceId: string}>('POST', '/sources', source, SLOW),
    deleteSource: (id: string) => request<void>('DELETE', `/sources/${id}`),
    createConnection: (connection: object) => request<AirbyteResource & { connectionId: string}>('POST', '/connections', connection, SLOW),
    deleteConnection: (id: string) => request<void>('DELETE', `/connections/${id}`),
    sync: (connectionId: string) => request<AirbyteJob>('POST', '/jobs', {connectionId, jobType: 'sync'}),
    /**
     * Records per stream across the connection's sync jobs: committed for finished jobs,
     * emitted so far for a running one. Null if Airbyte returns no per-stream stats.
     */
    async streamCounts(connectionId: string) {
      const {jobs = []} = await config<{jobs?: JobStatistics[]}>('/jobs/list', {configTypes: ['sync'], configId: connectionId, pagination: {pageSize: 100}});
      const counts: Record<string, number> = {};
      let found = false;
      for (const {job, attempts = []} of jobs) {
        const running = ['pending', 'running', 'incomplete'].includes(job.status);
        const stats = job.streamAggregatedStats?.length ? job.streamAggregatedStats.map(s => ({name: s.streamName, ...s}))
          : (attempts.at(-1)?.streamStats || []).map(s => ({name: s.streamName, ...s.stats}));
        for (const stat of stats) {
          found = true;
          counts[stat.name] = (counts[stat.name] || 0) + ((running ? stat.recordsEmitted : stat.recordsCommitted ?? stat.recordsEmitted) || 0);
        }
      }
      return found ? counts : null;
    },
    async latestSyncJobId(connectionId:string):Promise<string|null>{
      const job = await latestJob(connectionId,true);
      return job ? String(job.jobId) : null;
    },
    async drainConnection(connectionId:string, existing:AirbyteResource|null) {
      const pending = () => Object.assign(new Error('Waiting for Airbyte writers to stop'), {code:'AirbyteDrainPending'});
      const path = '/connections/'+encodeURIComponent(connectionId);
      if (existing && existing.status !== 'inactive') {
        if (existing.status !== 'active') throw pending();
        await request('PATCH',path,{status:'inactive'});
        const paused = await request<AirbyteResource>('GET',path);
        if (paused.connectionId !== connectionId || paused.status !== 'inactive') throw pending();
      }
      // Airbyte serializes jobs for each connection. The schedule is disabled
      // before inspecting the latest job on that connection, including resets.
      const job = await latestJob(connectionId);
      if (!job || terminal(job.status)) return;
      if (!existing) throw pending();
      await request('DELETE','/jobs/'+job.jobId).catch(error=>{
        if (![404,409].includes((error as {status?:number}).status??0)) throw error;
      });
      const current = boundJob(await request<BoundJob>('GET','/jobs/'+job.jobId),connectionId);
      if (current.jobId !== job.jobId || current.jobType !== job.jobType || !terminal(current.status)) throw pending();
    },
    jobs: (connectionId: string, limit = 20) => request<Page<AirbyteJob>>('GET', `/jobs?connectionId=${connectionId}&limit=${limit}&orderBy=createdAt%7CDESC`).then(r => r?.data || []),
  };
}

export type Airbyte = ReturnType<typeof createAirbyte>;
