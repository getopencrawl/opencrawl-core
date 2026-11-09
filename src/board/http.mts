import type {Authenticate, HttpHandler, Principal} from '../sessions/types.mjs';
import type {createBoard} from './board.mjs';
import {serviceError} from '../sessions/types.mjs';
import {participationSchemas} from './participation.mjs';
import type {BoardListeners} from './listener.mjs';
import {isListenerToken} from './listener.mjs';

/**
 * Short, authenticated requests. The CLI owns polling/reconnect, never a terminal.
 * With `listeners`, POST /api/board/listener redeems a single-use ticket for a
 * session-bound listener token, and such tokens authenticate participation for
 * that session only. `revalidate` lets a deployment re-check the token owner's
 * current membership on every request (it may return a refreshed principal).
 * Adapters that wrap `board` and rebuild principals must carry `boardSession`
 * through unchanged; dropping it would widen a listener token to every session.
 */
export function createBoardHandler({board, authenticate, listeners, revalidate}: {board?: ReturnType<typeof createBoard>; authenticate: Authenticate;
  listeners?: BoardListeners; revalidate?: (principal: Principal) => Promise<Principal | null>}): HttpHandler {
  const confirm = async (principal: Principal) => {
    const current = revalidate ? await revalidate(principal) : principal;
    if (!current || current.tenantId !== principal.tenantId || current.userId !== principal.userId) throw Object.assign(new Error('Listener owner no longer has workspace access'), {status: 403});
    return {...current, captureAccess: undefined, boardSession: principal.boardSession};
  };
  return async (req, res) => {
    const send = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
      res.end(JSON.stringify({schemaVersion: 1, ...body}));
    };
    try {
      if (req.method !== 'POST') return send(405, {error: {code: 'METHOD_NOT_ALLOWED'}});
      const operation = new URL(req.url ?? '', 'http://board.invalid').pathname.slice('/api/board/'.length);
      const redeem = operation === 'listener' && listeners;
      if (!redeem && !Object.hasOwn(participationSchemas, operation)) return send(404, {error: {code: 'NOT_FOUND'}});
      const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
      const listenerToken = listeners && isListenerToken(bearer) ? bearer : null;
      let principal: Principal | null = null;
      if (listenerToken) {
        const bound = await listeners!.authenticate(listenerToken);
        if (!bound) return send(401, {error: {code: 'AUTH_REQUIRED', message: 'Listener token expired or revoked; request a new listener ticket'}});
        principal = await confirm(bound);
      } else if (!redeem) principal = await authenticate(req);
      if (!redeem && !principal) return send(401, {error: {code: 'AUTH_REQUIRED'}});
      if (!board?.participate) return send(503, {error: {code: 'BOARD_UNAVAILABLE'}});
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16_384) return send(413, {error: {code: 'REQUEST_TOO_LARGE'}});
        chunks.push(chunk);
      }
      let input;
      try {input = JSON.parse(Buffer.concat(chunks).toString());}
      catch {return send(400, {error: {code: 'INVALID_REQUEST'}});}
      if (redeem) {
        const {ticket, session} = (input ?? {}) as {ticket?: unknown; session?: unknown};
        const granted = await listeners!.redeem(ticket, session);
        try {await confirm(granted.principal);} catch (denied) {await listeners!.revoke(granted.token); throw denied;}
        return send(200, {data: {token: granted.token, session: granted.session, workspace: granted.principal.tenantId, expiresAt: granted.expiresAt, access: 'board-listener'}});
      }
      const data = await board.participate(principal!, operation, input);
      if (listenerToken && operation === 'leave') await listeners!.revoke(listenerToken);
      send(200, {data});
    } catch(caught){const error=serviceError(caught);
      const status = error.name === 'ZodError' ? 400 : error.status || 503;
      send(status, {error: {code: status >= 500 ? 'BOARD_UNAVAILABLE' : 'BOARD_REQUEST_FAILED',
        message: error.name !== 'ZodError' && status < 500 ? error.message : 'Board request could not be completed'}});
    }
  };
}
