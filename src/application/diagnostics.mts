import type {IncomingMessage} from 'node:http';
import type {Principal} from '../identity/types.mjs';
import type {createSessionSearch} from '../sessions/search.mjs';
import type {createConnectorResolver} from '../integrations/resolver.mjs';
import type {createBoard} from '../board/board.mjs';
import {boardReadSchema} from '../board/board.mjs';
import {errorInfo} from '../errors.mjs';
export interface DiagnosticOptions {
  search?: ReturnType<typeof createSessionSearch> | null;
  connectors?: ReturnType<typeof createConnectorResolver> | null;
  board?: Pick<ReturnType<typeof createBoard>, 'read'>;
}
export async function diagnosticRequest(req: IncomingMessage, url: URL, route: {name: string}, {
  search, connectors, board, principal, admin, revalidate, respond, onSearch,
}: DiagnosticOptions & {principal: Principal; admin: boolean; revalidate(): Promise<number>;
  respond(status: number, body: string, type?: string): void; onSearch?(length: number): void}) {
  if (!admin) return respond(403, 'Organization admin access required');
  try {
      if (route.name === 'debug-board') {
        const json = (status: number, value: unknown) => respond(status, JSON.stringify(value), 'application/json');
        if ([...url.searchParams.keys()].some(key => !['topic', 'before'].includes(key) || url.searchParams.getAll(key).length !== 1)) return json(400, {error: 'INVALID_QUERY'});
        const input = boardReadSchema.safeParse({
          ...(url.searchParams.has('topic') ? {topic: url.searchParams.get('topic')} : {}),
          ...(url.searchParams.has('before') ? {before: Number(url.searchParams.get('before'))} : {}),
        });
        if (!input.success) return json(400, {error: 'INVALID_QUERY'});
        if (!board) return json(503, {error: 'BOARD_NOT_CONFIGURED'});
        const result = await board.read(principal, input.data);
        const status = await revalidate();
        if (status !== 200) return json(status, {error: status === 503 ? 'AUTH_UNAVAILABLE' : 'WORKSPACE_ACCESS_DENIED'});
        return json(200, result);
      }
      if (route.name === 'debug-search') {
        const json = (status: number, value: unknown) => respond(status, JSON.stringify(value), 'application/json');
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) {bytes += chunk.length; if (bytes > 16384) return json(413, {error: 'REQUEST_TOO_LARGE'}); chunks.push(chunk);}
        let decoded: unknown;
        try {decoded = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {return json(400, {error: 'INVALID_JSON'});}
        const input = decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded as Record<string, unknown> : null;
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'query') ||
          typeof input.query !== 'string' || !input.query.trim() || input.query.length > 4000) return json(400, {error: 'INVALID_QUERY'});
        if (!principal) return json(403, {error: 'WORKSPACE_ACCESS_DENIED'});
        if (!search) return json(503, {error: 'SEARCH_NOT_CONFIGURED'});
        const scopes = [principal];
        const query = {query: input.query.trim(), limit: 20, raw: true};
        const read = async <T,>(operation: () => Promise<T>) => {
          try {return await operation();}
          catch (error) {
            if (errorInfo(error).status === 404 && errorInfo(error).type === 'index_not_found_exception') return {state: 'pending', responses: []};
            throw error;
          }
        };
        const [sessions, connected, memories] = await Promise.all([
          Promise.all(scopes.map(async scope => ({scope: 'workspace', response: await read(() => search.search(scope, query))}))),
          connectors ? read(() => connectors.search(principal, query)) : {state: 'not_configured', responses: []},
          search.memories ? read(async () => {
            const result = await search.memories.search(principal, {query: query.query, limit: query.limit});
            return {state: 'ready', truncated: result.truncated, hits: {total: {value: result.total},
              hits: result.hits.map(({id, score, ...document}) => ({_id: id, _score: score, _source: document}))}};
          }) : {state: 'not_configured', hits: {total: {value: 0}, hits: []}},
        ]);
        // Revalidate membership after retrieval as well as before it.
        const status = await revalidate();
        if (status !== 200) return json(status, {error: status === 503 ? 'AUTH_UNAVAILABLE' : 'WORKSPACE_ACCESS_DENIED'});
        onSearch?.(input.query.length);
        return json(200, {sessions, connectors: connected, memories});
      }
  } catch(error) {
    if(errorInfo(error).status===403)return respond(403,JSON.stringify({error:'WORKSPACE_ACCESS_DENIED'}),'application/json');
    throw error;
  }
}
