import type {Provider, ProviderData} from './types.mjs';
// Self-host source catalog. Each entry is signed in through the operator's Composio project
// (or a pasted workspace key) and synced by deploy/connectors with the manifest of the same id.
// Only providers the core indexing pipeline supports are offered.
const SLACK = 'https://slack.com/api';
const GRANOLA = 'https://public-api.granola.ai';
const NOTION = 'https://api.notion.com/v1';
const CIRCLEBACK = 'https://circleback.ai/api';
// Composio's Notion proxy defaults to 2022-06-28, which predates data sources and page markdown.
export const NOTION_VERSION = '2026-03-11';
/** Streams the indexer reads, with the cursors hosted OpenCrawl syncs them by. */
const incremental = (name: string, cursor: string) => ({name, syncMode: 'incremental' as const, cursorField: [cursor]});
const full = (name: string) => ({name, syncMode: 'full_refresh' as const});
const exposed = (message: string) => Object.assign(new Error(message), {status: 400, expose: true});

export const providers: Readonly<Record<string, Provider>> = Object.freeze({
  slack: {
    id: 'slack', name: 'Slack', description: 'Public channels in your workspace.', auth: 'oauth', toolkit: 'slack', access: 'team-public',
    help: 'One person connects Slack for the whole team. OpenCrawl reads public channels only, including threads, never DMs or private channels.',
    // Messages and replies come from search (search:read) restricted to public channels.
    authConfig: {name: 'OpenCrawl Slack search v4', credentials: {user_scopes: 'channels:read,channels:history,search:read,users:read,team:read,emoji:read'}},
    // An incremental sync is two searches plus a few list calls, whatever the channel count.
    sync: {everyMinutes: 15, streams: [full('channels'), full('users'), incremental('messages', 'ts'), incremental('threads', 'ts')],
      config: record => ({start_date: record.startDate, num_workers: 1, search_lookback: 'P1D'})},
    async account(proxy) {
      const {data} = await proxy({endpoint: `${SLACK}/auth.test`});
      if (!data?.ok || !/^[TE][A-Z0-9]+$/.test(data.team_id || '')) throw new Error(`Slack auth.test failed: ${data?.error || 'no workspace'}`);
      return {label: [data.team, data.user].filter(Boolean).join(', '), workspace: data.team_id!};
    },
  },
  notion: {
    id: 'notion', name: 'Notion', description: 'Pages and databases shared with OpenCrawl.', auth: 'oauth', toolkit: 'notion', access: 'workspace-global',
    help: 'One person connects Notion for the whole team and, in Notion’s window, selects the pages to share. OpenCrawl imports those pages, everything beneath them, databases and comments.',
    // Notion has no scopes: access is the pages chosen in Notion's page picker.
    authConfig: {name: 'OpenCrawl Notion read', credentials: {}},
    // Everything shared, whatever its age: Notion is a knowledge base, not a feed.
    sync: {everyMinutes: 60, streams: [incremental('pages', 'last_edited_time'), incremental('data_sources', 'last_edited_time'),
      incremental('page_markdown', 'page_last_edited_time'), incremental('comments', 'page_last_edited_time'), full('users')],
      config: () => ({start_date: '2000-01-01T00:00:00Z', notion_version: NOTION_VERSION, num_workers: 3, requests_per_minute: 170})},
    async account(proxy) {
      const {status, data} = await proxy({endpoint: `${NOTION}/users/me`, headers: {'Notion-Version': NOTION_VERSION}});
      const workspace = data?.bot?.workspace_id;
      if (status >= 400 || !workspace || !/^[a-f0-9-]{36}$/.test(workspace)) throw new Error(`Notion users/me failed with ${status}`);
      return {label: data!.bot!.workspace_name || 'Notion workspace', workspace};
    },
  },
  circleback: {
    id: 'circleback', name: 'Circleback', description: 'Meeting notes shared with your whole workspace.', auth: 'oauth', toolkit: 'circleback_mcp', access: 'workspace-global',
    help: 'One person connects Circleback for the whole team. OpenCrawl imports only meetings in the Circleback Workspace folder, never private meetings, private notes or recordings.',
    // Composio has no managed Circleback app; it registers the OAuth client itself. `user` is read-only.
    authConfig: {name: 'OpenCrawl Circleback read', scheme: 'DCR_OAUTH', credentials: {scopes: 'user'}},
    sync: {everyMinutes: 60, streams: [incremental('meetings', 'updatedAt'), incremental('transcripts', 'meeting_updated_at')],
      config: record => {
        if (record.settings.folderId === undefined) throw new Error('Circleback Workspace folder is missing; disconnect and connect again');
        return {start_date: record.startDate, folder_id: String(record.settings.folderId), num_workers: 2};
      }},
    async account(proxy) {
      const [me, folders] = await Promise.all([proxy({endpoint: `${CIRCLEBACK}/oauth/test`}), proxy<Array<{id: string | number; type: string; workspaceId: string | number; name?: string}>>({endpoint: `${CIRCLEBACK}/folder`})]);
      if (me.status >= 400 || !me.data?.email) throw new Error(`Circleback account lookup failed with ${me.status}`);
      if (folders.status >= 400 || !Array.isArray(folders.data)) throw new Error(`Circleback returned ${folders.status} while listing folders`);
      const shared = folders.data.find(folder => folder.type === 'Workspace');
      if (!shared?.id || !shared.workspaceId) throw exposed('Your Circleback account isn’t in a workspace, so it has no meetings shared with the team.');
      return {label: `${me.data.email}, ${shared.name || 'Workspace'} folder`, workspace: String(shared.workspaceId), settings: {folderId: shared.id}};
    },
  },
  granola: {
    id: 'granola', name: 'Granola', description: 'Meeting notes shared with your whole workspace.', auth: 'api-key', access: 'workspace-global',
    help: 'A Granola admin connects Granola once with a workspace API key. OpenCrawl imports notes and transcripts shared with everyone in your workspace, never private notes.',
    keyHelp: {
      title: 'Connect Granola for your team',
      body: 'Paste a Granola workspace API key. A Granola admin creates one in Granola under Settings → Connectors → Workspace API keys. Don’t use a personal API key: it can read its owner’s private notes.',
      label: 'Workspace API key', placeholder: 'grn_…', pattern: '^[A-Za-z0-9_.-]{12,400}$',
    },
    sync: {everyMinutes: 60, streams: [incremental('notes', 'updated_at'), incremental('transcripts', 'note_updated_at')],
      config: record => ({start_date: record.startDate, num_workers: 2})},
    /** A personal key returns its owner's private notes, so any sign of those is refused. */
    async account(api, tenantId) {
      const [{status, data}, listed] = await Promise.all([api<ProviderData>({endpoint: `${GRANOLA}/v1/spaces`, query: {page_size: 30}}), api<ProviderData>({endpoint: `${GRANOLA}/v1/notes`, query: {page_size: 10}})]);
      if (status === 401) throw exposed('Granola didn’t accept that API key.');
      if (status >= 400 || listed.status >= 400) throw new Error(`Granola returned ${Math.max(status, listed.status)} while checking the key`);
      const notes = await Promise.all((listed.data?.notes || []).slice(0, 5).map(({id}) => api<ProviderData>({endpoint: `${GRANOLA}/v1/notes/${encodeURIComponent(id)}`})));
      if (notes.some(note => note.data?.private_notes_text || note.data?.private_notes_markdown)) throw exposed('That looks like a personal API key. Ask a Granola admin for a workspace API key instead.');
      const spaces = (data?.spaces || []).map(s => s.name).filter(Boolean);
      // Granola exposes no workspace ID: the deployment's tenant owns it.
      return {label: spaces.length ? `Spaces: ${spaces.join(', ')}` : 'Shared notes', workspace: tenantId};
    },
  },
});
