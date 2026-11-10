import type {Proxy, ProviderCatalog, ConnectorDefinition} from './types.mjs';
// Gmail is hidden for now; see the commented-out provider below.
// const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SLACK = 'https://slack.com/api';
export const GRANOLA = 'https://public-api.granola.ai';
const NOTION = 'https://api.notion.com/v1';
const CIRCLEBACK = 'https://circleback.ai/api';
/** Circleback pages with an RFC 8288 `Link: <…?cursor=…>; rel="next"` header. */
export function nextCursor(headers: Record<string, string> = {}) {
  const link = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === 'link')?.[1] || '';
  return /[?&]cursor=([^&>]+)[^>]*>;\s*rel="?next/.exec(link)?.[1] || undefined;
}
/** Shared drives the connected Google account belongs to (never My Drive). */
async function sharedDrives(proxy: Proxy) {
  const drives: Array<{id: string; name?: string}> = [];
  let pageToken: string | undefined;
  do {
    const {status, data} = await proxy({endpoint: `${DRIVE}/drives`, query: {pageSize: 100, fields: 'nextPageToken,drives(id,name)', pageToken}});
    if (status >= 400) throw new Error(`Google Drive returned ${status} while listing shared drives`);
    drives.push(...(data?.drives || []));
    pageToken = data?.nextPageToken;
  } while (pageToken);
  return drives;
}
// Data sources and page markdown require this Notion API version.
export const NOTION_VERSION = '2026-03-11';
// The connector stops listing ten minutes before now so Gmail's search index has caught up.
// const SETTLE_MS = 10 * 60_000;

export function createProviderCatalog(connectors: Record<string,ConnectorDefinition>): ProviderCatalog {
const providers:ProviderCatalog = {
  googledrive: {
    id: 'googledrive',
    name: 'Google Drive',
    unavailableReason: 'Google Drive indexing is not available in this release. Connecting an account would not make its files searchable. Use another source for now.',
    description: 'Files in your team’s shared drives.',
    toolkit: 'googledrive',
    // Per team, shared drives only. The connector lists each shared drive the signer belongs to
    // (corpora=drive) and never reads My Drive or files merely shared with them. Google exposes
    // no Workspace ID to Drive, so it is stored under workspace=<OpenCrawl team>.
    scope: 'team',
    teamOnly: true,
    help: 'Google Drive indexing is not available in this release. The source adapter is retained for development, but new connections are disabled until files can be indexed and retrieved.',
    owner: record => `workspace=${record.workspace}`,
    authConfig: {name: 'OpenCrawl Google Drive shared read', credentials: {scopes: 'https://www.googleapis.com/auth/drive.readonly'}},
    connector: connectors.googledrive,
    streams: [
      {name: 'drives', syncMode: 'full_refresh_append'},
      {name: 'files', syncMode: 'incremental_append', cursorField: ['modifiedTime']},
      // Docs as markdown, Sheets as CSV (first sheet), Slides as text, for files that changed.
      {name: 'contents', syncMode: 'incremental_append', cursorField: ['modifiedTime']},
    ],
    progressStream: ['files'],
    progress: [
      {stream: 'drives', label: 'Shared drives'},
      {stream: 'files', label: 'Files'},
      {stream: 'contents', label: 'Documents read'},
    ],
    units: ['file', 'files'],
    // Everything in the shared drives, whatever its age: Drive is a knowledge base, not a feed.
    sourceConfiguration: () => ({start_date: '2000-01-01T00:00:00Z', num_workers: 3, requests_per_minute: 600}),
    /** The shared drives this connection can read, shown on the card. */
    async account(proxy, {tenantId}) {
      const drives = await sharedDrives(proxy);
      const names = drives.map(d => d.name).filter(Boolean);
      return {label: names.length ? `Shared drives: ${names.join(', ')}` : 'No shared drives yet', workspace: tenantId};
    },
    /** Files in every shared drive, listed the way the connector lists them. */
    async total(proxy, {maxPages = 200} = {}) {
      let count = 0;
      for (const drive of await sharedDrives(proxy)) {
        let pageToken: string | undefined;
        for (let page = 0; page < maxPages; page++) {
          const {status, data} = await proxy({endpoint: `${DRIVE}/files`, query: {corpora: 'drive', driveId: drive.id, includeItemsFromAllDrives: true,
            supportsAllDrives: true, pageSize: 1000, q: 'trashed = false', fields: 'nextPageToken,files(id,driveId)', pageToken}});
          if (status >= 400) throw new Error(`Google Drive returned ${status} while counting files`);
          count += (data?.files || []).filter(f => f.driveId === drive.id).length;
          if (!(pageToken = data?.nextPageToken)) break;
        }
      }
      return count;
    },
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    description: 'Public channels in your workspace.',
    toolkit: 'slack',
    // Per team: public channels are shared, so one connection serves the whole team,
    // stored under workspace=<Slack team ID>.
    scope: 'team',
    help: 'One person connects Slack for the whole team. OpenCrawl reads public channels only, including threads and reactions, never DMs or private channels.',
    owner: record => `workspace=${record.workspace}`,
    // Read-only. Messages and replies come from search (search:read): one query per window names
    // every public channel (repeated in: clauses are ORed), never DMs or private channels.
    // channels:history supports fetching long messages. Plus channel list,
    // members, workspace, emoji.
    authConfig: {name: 'OpenCrawl Slack search v4', credentials: {user_scopes: 'channels:read,channels:history,search:read,users:read,team:read,emoji:read'}},
    connector: connectors.slack,
    streams: [
      // Snapshots per sync, never overwritten: readers take the newest sync.
      {name: 'channels', syncMode: 'full_refresh_append'},
      {name: 'users', syncMode: 'full_refresh_append'},
      {name: 'messages', syncMode: 'incremental_append', cursorField: ['ts']},
      {name: 'threads', syncMode: 'incremental_append', cursorField: ['ts']},
      {name: 'emoji', syncMode: 'full_refresh_append'},
    ],
    // An incremental sync is two searches plus a few list calls, whatever the channel count.
    schedule: '0 0/15 * * * ?',
    progressStream: ['messages', 'threads'],
    progress: [
      {stream: 'channels', label: 'Channels'},
      {stream: 'users', label: 'Members'},
      {stream: 'messages', label: 'Messages'},
      {stream: 'threads', label: 'Thread replies'},
    ],
    units: ['message', 'messages'],
    sourceConfiguration: ({startDate}) => ({start_date: startDate, num_workers: 1, search_lookback: 'P1D'}),
    async account(proxy) {
      const {data} = await proxy({endpoint: `${SLACK}/auth.test`});
      if (!data?.ok || !/^[TE][A-Z0-9]+$/.test(data.team_id || '')) throw new Error(`Slack auth.test failed: ${data?.error || 'no workspace'}`);
      return {label: [data.team, data.user].filter(Boolean).join(', '), workspace: data.team_id};
    },
    /** Messages and replies the import will find: one search count per 30 public channels. */
    async total(proxy, {startDate}) {
      const channels: Array<{name: string}> = [];
      let cursor: string | undefined;
      do {
        const {data} = await proxy({endpoint: `${SLACK}/conversations.list`, query: {types: 'public_channel', exclude_archived: false, limit: 200, cursor}});
        if (!data?.ok) throw new Error(`Slack conversations.list failed: ${data?.error}`);
        channels.push(...data.channels);
        cursor = data.response_metadata?.next_cursor;
      } while (cursor);
      const after = new Date(Date.parse(startDate!) - 86_400_000).toISOString().slice(0, 10);
      let total = 0;
      for (let i = 0; i < channels.length; i += 30) {
        const names = channels.slice(i, i + 30).map(channel => `in:#${channel.name}`).join(' ');
        const {data} = await proxy({endpoint: `${SLACK}/search.messages`, query: {query: `${names} after:${after}`, count: 1}});
        total += data?.messages?.total || 0;
      }
      return total;
    },
  },
  granola: {
    id: 'granola',
    name: 'Granola',
    description: 'Meeting notes shared with your whole workspace.',
    // A workspace API key is created by a Granola admin and, on Granola's side, can only read
    // notes shared with the whole workspace or in spaces with API access.
    auth: 'api-key',
    // Per team: one workspace key serves everyone, stored under workspace=<OpenCrawl team>,
    // because Granola's API doesn't expose a workspace ID.
    scope: 'team',
    teamOnly: true,
    help: 'A Granola admin connects Granola once for the whole team with a workspace API key. OpenCrawl imports notes and transcripts shared with everyone in your workspace, never private notes.',
    keyHelp: {
      title: 'Connect Granola for your team',
      body: 'Paste a Granola workspace API key. A Granola admin creates one in Granola under Settings → Connectors → Workspace API keys (Business and Enterprise plans). Don’t use a personal API key: it can read its owner’s private notes. OpenCrawl only imports notes shared with everyone in your workspace.',
      label: 'Workspace API key',
      placeholder: 'grn_…',
      // Granola's docs show grn_… keys but don't promise a format for workspace keys.
      pattern: '^[A-Za-z0-9_.-]{12,400}$',
    },
    owner: record => `workspace=${record.workspace}`,
    connector: connectors.granola,
    streams: [
      {name: 'notes', syncMode: 'incremental_append', cursorField: ['updated_at']},
      {name: 'transcripts', syncMode: 'incremental_append', cursorField: ['note_updated_at']},
    ],
    progressStream: ['notes'],
    progress: [
      {stream: 'notes', label: 'Notes'},
      {stream: 'transcripts', label: 'Transcript lines'},
    ],
    units: ['note', 'notes'],
    sourceConfiguration: ({startDate, apiKey}) => ({api_key: apiKey, start_date: startDate, num_workers: 2}),
    /**
     * Checks the key and labels the card with the spaces it can read. Granola can't say whether
     * a key is a workspace key, but a personal key returns its owner's private scratch notes on
     * notes they created, so any sign of those is refused.
     */
    async account(api, {tenantId}) {
      // The user is waiting on this: independent calls run together.
      const [{status, data}, listed] = await Promise.all([
        api({endpoint: `${GRANOLA}/v1/spaces`, query: {page_size: 30}}),
        api({endpoint: `${GRANOLA}/v1/notes`, query: {page_size: 10}}),
      ]);
      if (status === 401) throw Object.assign(new Error('Granola didn’t accept that API key.'), {status: 400, expose: true});
      if (status >= 400) throw new Error(`Granola returned ${status} while listing spaces`);
      if (listed.status >= 400) throw new Error(`Granola returned ${listed.status} while listing notes`);
      const notes = await Promise.all((listed.data?.notes || []).slice(0, 5).map(({id}) => api({endpoint: `${GRANOLA}/v1/notes/${encodeURIComponent(id)}`})));
      if (notes.some(note => note.data?.private_notes_text || note.data?.private_notes_markdown)) {
        throw Object.assign(new Error('That looks like a personal API key. Ask a Granola admin for a workspace API key instead.'), {status: 400, expose: true});
      }
      const spaces = (data?.spaces || []).map(s => s.name).filter(Boolean);
      return {label: spaces.length ? `Spaces: ${spaces.join(', ')}` : 'Shared notes', workspace: tenantId};
    },
    /** Notes the backfill will read. Notes outside any space or folder are skipped later, so this is an upper bound. */
    async total(api, {startDate, maxPages = 100}) {
      let count = 0, cursor: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const {status, data} = await api({endpoint: `${GRANOLA}/v1/notes`, query: {page_size: 30, updated_after: startDate, cursor}});
        if (status >= 400) throw new Error(`Granola returned ${status} while counting notes`);
        count += (data?.notes || []).filter(n => !n.deleted_at).length;
        if (!data?.hasMore || !(cursor = data.cursor)) return count;
      }
      return count;
    },
  },
  circleback: {
    id: 'circleback',
    name: 'Circleback',
    description: 'Meeting notes shared with your whole workspace.',
    // Circleback uses dynamic OAuth client registration; the credential adapter owns the grant.
    toolkit: 'circleback_mcp',
    // Per team, like Granola: only meetings in Circleback's Workspace folder, which holds the
    // meetings shared with everyone in the workspace, so one connection serves the whole team,
    // stored under workspace=<Circleback workspace ID>. Circleback has no workspace credential,
    // so it is one member's grant, and everything private to that member is left out.
    scope: 'team',
    teamOnly: true,
    help: 'One person connects Circleback for the whole team. OpenCrawl imports only meetings shared with everyone in your Circleback workspace (its Workspace folder), with notes, action items and transcripts, never private meetings, private notes or recordings.',
    owner: record => `workspace=${record.workspace}`,
    // `user` is Circleback's read-only scope (`user:write` would allow edits).
    authConfig: {name: 'OpenCrawl Circleback read', scheme: 'DCR_OAUTH', credentials: {scopes: 'user'}},
    connector: connectors.circleback,
    streams: [
      {name: 'meetings', syncMode: 'incremental_append', cursorField: ['updatedAt']},
      {name: 'transcripts', syncMode: 'incremental_append', cursorField: ['meeting_updated_at']},
    ],
    progressStream: ['meetings'],
    progress: [
      {stream: 'meetings', label: 'Meetings'},
      {stream: 'transcripts', label: 'Transcript lines'},
    ],
    units: ['meeting', 'meetings'],
    // Circleback returns numeric folder IDs; the connector's configuration takes a string.
    sourceConfiguration: ({startDate, record}) => ({start_date: startDate, folder_id: record!.settings?.folderId === undefined ? undefined : String(record!.settings.folderId), num_workers: 2}),
    /** The signed-in account and the workspace's shared Workspace folder, the only one read. */
    async account(proxy) {
      const [me, folders] = await Promise.all([proxy({endpoint: `${CIRCLEBACK}/oauth/test`}), proxy<Array<{id: string | number; type: string; workspaceId: string | number; name?: string}>>({endpoint: `${CIRCLEBACK}/folder`})]);
      if (me.status >= 400 || !me.data?.email) throw new Error(`Circleback account lookup failed with ${me.status}`);
      if (folders.status >= 400 || !Array.isArray(folders.data)) throw new Error(`Circleback returned ${folders.status} while listing folders`);
      const shared = folders.data.find(folder => folder.type === 'Workspace');
      if (!shared?.id || !shared.workspaceId) throw Object.assign(new Error('Your Circleback account isn’t in a workspace, so it has no meetings shared with the team.'), {status: 400, expose: true});
      return {label: `${me.data.email}, ${shared.name || 'Workspace'} folder`, workspace: String(shared.workspaceId), settings: {folderId: shared.id}};
    },
    /** Meetings the backfill will import: the Workspace folder's, updated since the start date. */
    async total(proxy, {startDate, record, maxPages = 200}) {
      const since = Date.parse(startDate!);
      let count = 0, cursor: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const {status, data, headers} = await proxy<Array<{updatedAt: string}>>({endpoint: `${CIRCLEBACK}/meetings`, query: {ownership: 'All', folderId: record!.settings!.folderId, cursor}});
        if (status >= 400) throw new Error(`Circleback returned ${status} while counting meetings`);
        count += (Array.isArray(data) ? data : []).filter(m => Date.parse(m.updatedAt) >= since).length;
        if (!(cursor = nextCursor(headers))) return count;
      }
      return count;
    },
  },
  notion: {
    id: 'notion',
    name: 'Notion',
    description: 'Pages and databases shared with OpenCrawl.',
    toolkit: 'notion',
    // Per team: one connection serves everyone, stored under workspace=<Notion workspace ID>.
    scope: 'team',
    help: 'One person connects Notion for the whole team and, in Notion’s window, selects the top page of every teamspace to share. OpenCrawl imports those pages, everything beneath them, databases, and comments, and keeps them up to date every hour.',
    owner: record => `workspace=${record.workspace}`,
    // Notion has no scopes: access is the pages chosen in Notion's page picker.
    authConfig: {name: 'OpenCrawl Notion read', credentials: {}},
    connector: connectors.notion,
    streams: [
      {name: 'pages', syncMode: 'incremental_append', cursorField: ['last_edited_time']},
      {name: 'data_sources', syncMode: 'incremental_append', cursorField: ['last_edited_time']},
      // Content and comments of pages that changed (plus the weekly re-read of every page).
      {name: 'page_markdown', syncMode: 'incremental_append', cursorField: ['page_last_edited_time']},
      {name: 'comments', syncMode: 'incremental_append', cursorField: ['page_last_edited_time']},
      {name: 'users', syncMode: 'full_refresh_append'},
    ],
    progressStream: ['page_markdown'],
    progress: [
      {stream: 'page_markdown', label: 'Pages'},
      {stream: 'data_sources', label: 'Databases'},
      {stream: 'comments', label: 'Comments'},
      {stream: 'users', label: 'Members'},
    ],
    units: ['page', 'pages'],
    // Everything shared, whatever its age: Notion is a knowledge base, not a feed.
    sourceConfiguration: () => ({start_date: '2000-01-01T00:00:00Z', notion_version: NOTION_VERSION, num_workers: 3, requests_per_minute: 170}),
    async account(proxy) {
      const {status, data} = await proxy({endpoint: `${NOTION}/users/me`, headers: {'Notion-Version': NOTION_VERSION}});
      const workspace = data?.bot?.workspace_id;
      if (status >= 400 || !/^[a-f0-9-]{36}$/.test(workspace || '')) throw new Error(`Notion users/me failed with ${status}`);
      return {label: data!.bot!.workspace_name || 'Notion workspace', workspace};
    },
    /** Pages shared with the connection, from the same search the connector lists them with. */
    async total(proxy, {maxPages = 2000} = {}) {
      let count = 0, cursor: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const {status, data} = await proxy({endpoint: `${NOTION}/search`, method: 'POST', headers: {'Notion-Version': NOTION_VERSION},
          body: {filter: {property: 'object', value: 'page'}, page_size: 100, ...(cursor ? {start_cursor: cursor} : {})}});
        if (status >= 400) throw new Error(`Notion returned ${status} while counting pages`);
        count += (data?.results || []).filter(p => !p.in_trash).length;
        if (!data?.has_more || !(cursor = data.next_cursor)) return count;
      }
      return count;
    },
  },
  github: {
    id: 'github',
    name: 'GitHub',
    description: 'Code, history, pull requests and issues of the repositories you choose.',
    // The operator-owned read-only GitHub App: the owner picks repositories at
    // install, and its installation tokens can clone. Shown only when the app is configured.
    auth: 'github-app',
    // Per team: one installation serves everyone, stored under workspace=<GitHub account ID>.
    scope: 'team',
    help: 'One person installs the OpenCrawl GitHub App for the whole team and chooses the repositories. OpenCrawl imports their code, every commit with its changes, pull requests with reviews, issues, discussions and comments, read-only, and keeps them up to date every hour.',
    owner: record => `workspace=${record.workspace}`,
    connector: connectors.github,
    streams: [
      {name: 'repositories', syncMode: 'full_refresh_append'},
      // From a clone of each repository: no API quota.
      {name: 'branches', syncMode: 'full_refresh_append'},
      {name: 'tags', syncMode: 'full_refresh_append'},
      {name: 'commits', syncMode: 'incremental_append', cursorField: ['committer_date']},
      {name: 'files', syncMode: 'incremental_append', cursorField: ['commit_sha']},
      // From the API, read-only.
      {name: 'pull_requests', syncMode: 'incremental_append', cursorField: ['updated_at']},
      {name: 'issues', syncMode: 'incremental_append', cursorField: ['updated_at']},
      {name: 'issue_comments', syncMode: 'incremental_append', cursorField: ['updated_at']},
      {name: 'review_comments', syncMode: 'incremental_append', cursorField: ['updated_at']},
      {name: 'commit_comments', syncMode: 'incremental_append', cursorField: ['updated_at']},
      {name: 'discussions', syncMode: 'incremental_append', cursorField: ['updated_at']},
      {name: 'releases', syncMode: 'full_refresh_append'},
    ],
    // Primary keys from connectors/github/source.py, for counting distinct records.
    keys: {
      repositories: ['id'], branches: ['repository', 'name'], tags: ['repository', 'name'], commits: ['repository', 'sha'],
      files: ['repository', 'path', 'commit_sha'], pull_requests: ['repository', 'number'], issues: ['repository', 'number'],
      issue_comments: ['repository', 'id'], review_comments: ['repository', 'id'], commit_comments: ['repository', 'id'],
      discussions: ['repository', 'number'], releases: ['repository', 'id'],
    },
    progressStream: ['commits'],
    progress: [
      {stream: 'repositories', label: 'Repositories'},
      {stream: 'commits', label: 'Commits'},
      {stream: 'files', label: 'Files'},
      {stream: 'pull_requests', label: 'Pull requests'},
      {stream: 'issues', label: 'Issues'},
      {stream: 'issue_comments', label: 'Comments'},
      {stream: 'review_comments', label: 'Review comments'},
      {stream: 'discussions', label: 'Discussions'},
    ],
    units: ['commit', 'commits'],
    // All history, whatever its age: the installation already limits what is read.
    sourceConfiguration: ({githubApp, record}) => {
      if (!record?.githubRepositoryIds?.length) throw new Error('Reconnect GitHub to confirm repository access');
      return {...githubApp, installation_id: String(record.installationId), repository_ids: record.githubRepositoryIds, start_date: '2000-01-01T00:00:00Z', num_workers: 4};
    },
    /** The account the app was installed on, and how many repositories it was given. */
    account: (installation, repositories) => ({
      label: `${installation.account.login}, ${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'}`,
      workspace: String(installation.account.id),
    }),
  },
};
return Object.freeze(Object.fromEntries(Object.entries(providers).filter(([id])=>Boolean(connectors[id]))));
}
