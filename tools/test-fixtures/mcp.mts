import type {IncomingMessage} from 'node:http';
import type {Principal} from '../../src/sessions/types.mjs';
import type {RealmOptions} from '../../src/search/types.mjs';
import type {McpOptions} from '../../src/mcp/server.mjs';
import {createWorkspaceSearchHandler} from '../../src/search/workspace.mjs';
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {createOpenCrawlMcp} from '../../src/mcp/server.mjs';
import {createBoardSearch} from '../../src/board/search.mjs';
import {createBoard} from '../../src/board/board.mjs';
import {createBoardHandler} from '../../src/board/http.mjs';
import {createLocalBoardStore} from '../../src/board/local-store.mjs';
import {createRecentSessions} from '../../src/sessions/recent.mjs';
import {createLibraryApi, createLibraryHandler} from '../../src/sessions/library-http.mjs';

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
