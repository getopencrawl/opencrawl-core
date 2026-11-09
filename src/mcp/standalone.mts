import type {IncomingMessage} from 'node:http';
import type {Principal} from '../sessions/types.mjs';
import type {RealmOptions} from '../search/types.mjs';
import type {McpOptions} from './server.mjs';
import {configuredWorkspaceSearch} from '../search/config.mjs';
import {createWorkspaceSearchHandler} from '../search/workspace.mjs';
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createOpenCrawlMcp} from './server.mjs';
import {createBoardSearch} from '../board/search.mjs';
import {createBoard} from '../board/board.mjs';
import {createBoardHandler} from '../board/http.mjs';
import {createLocalBoardStore} from '../board/local-store.mjs';
import {createRecentSessions} from '../sessions/recent.mjs';
import {standaloneStorage} from '../sessions/standalone.mjs';
import {createSessionLibrary} from '../sessions/library.mjs';
import {createMemoryLibrary} from '../memories/library.mjs';
import {createLibraryApi, createLibraryHandler} from '../sessions/library-http.mjs';

export function standaloneMcp({token, origin, revision, boardPath, boardSearch, recentSessions, library, search, principal={tenantId:'self-hosted',userId:'owner'}}: {token?: string; origin: string; revision?: string; boardPath?: string; boardSearch?: RealmOptions; recentSessions?: ReturnType<typeof createRecentSessions>; library?: ReturnType<typeof createLibraryApi>; search?: McpOptions['search']; principal?: Principal}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('Set MCP_TOKEN to a random secret of at least 32 characters');
  if(!principal?.tenantId||!principal?.userId)throw new Error('Explicit standalone scope required');
  const expected = Buffer.from('Bearer ' + token);
  const store = boardPath ? createLocalBoardStore(boardPath) : null;
  const board = store ? createBoard({store, prefix: 'board/v1', search: boardSearch ? createBoardSearch(boardSearch) : undefined, recentSessions}) : undefined;
  const authenticate = async (req: IncomingMessage) => {
    const actual = Buffer.from(req.headers.authorization || '');
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? principal : null;
  };
  const mcp = createOpenCrawlMcp({origin, revision, board, search, authenticate});
  const query = createWorkspaceSearchHandler({search, authenticate});
  const read = createWorkspaceSearchHandler({search, authenticate, operation:'fetch'});
  const participation = createBoardHandler({board, authenticate});
  const manage = createLibraryHandler({api: library ?? createLibraryApi({}), authenticate});
  const server = createServer((req, res) => {
    if (req.headers.host !== new URL(origin).host) {res.writeHead(403); return res.end();}
    if (req.url === '/api/search') {query(req, res);return;}
    if (req.url === '/api/search/fetch') {read(req, res);return;}
    if (req.url?.startsWith('/api/board/')) {participation(req, res);return;}
    if (req.url?.startsWith('/api/library/')) {manage(req, res);return;}
    if (req.url !== '/mcp') {res.writeHead(404); return res.end();}
    mcp(req, res).catch(() => {if (!res.headersSent) res.writeHead(503);res.end();});
  });
  server.on('close', () => {mcp.close(); store?.close();});
  server.requestTimeout = 15000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 8094 so it can run beside the session receiver's default 8093.
  const port = Number(process.env.PORT || 8094);
  const workspace: Partial<Awaited<ReturnType<typeof configuredWorkspaceSearch>>> = process.env.OPENCRAWL_SEARCH_CONFIG ? await configuredWorkspaceSearch(process.env.OPENCRAWL_SEARCH_CONFIG) : {};
  const sessionSettings = process.env.OPENCRAWL_OPENSEARCH_URL ? {endpoint: process.env.OPENCRAWL_OPENSEARCH_URL, index: process.env.OPENCRAWL_OPENSEARCH_INDEX || undefined,
    username: process.env.OPENCRAWL_OPENSEARCH_USERNAME, password: process.env.OPENCRAWL_OPENSEARCH_PASSWORD, tenantId: workspace.principal?.tenantId || process.env.OPENCRAWL_TENANT_ID || 'self-hosted'} : null;
  const capture = sessionSettings && process.env.OPENCRAWL_LANDING_S3_BUCKET ? standaloneStorage(process.env) : null;
  const server = standaloneMcp({principal:{tenantId:process.env.OPENCRAWL_TENANT_ID||'self-hosted',userId:process.env.OPENCRAWL_USER_ID||'owner'}, ...workspace, token: process.env.MCP_TOKEN, origin: process.env.MCP_ORIGIN || `http://127.0.0.1:${port}`, boardPath: process.env.OPENCRAWL_BOARD_PATH,
    recentSessions: capture && sessionSettings ? createRecentSessions({...sessionSettings, ...capture}) : undefined,
    library: capture && sessionSettings ? createLibraryApi({sessions: createSessionLibrary({...sessionSettings, ...capture}), memories: createMemoryLibrary({...sessionSettings, ...capture})}) : undefined,
    boardSearch: sessionSettings || undefined});
  // HOST is for containers; MCP_ORIGIN still pins the Host header clients must send.
  server.listen(port, process.env.HOST || '127.0.0.1');
  process.on('SIGTERM', () => server.close());
}
