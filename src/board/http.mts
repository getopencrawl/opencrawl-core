import {activityInput,admitActivity} from '../application/agent-activity.mjs';
import type {Authenticate, HttpHandler, Principal} from '../sessions/types.mjs';
import type {createBoard} from './board.mjs';
import {serviceError} from '../sessions/types.mjs';
import {boardRequestSchemas, boardValidationMessage} from './request-errors.mjs';

/** Short, authenticated requests. The CLI owns polling/reconnect, never a terminal. */
export function createBoardHandler({board, authenticate, sharedFiles = false}: {sharedFiles?: boolean | ((principal: Principal) => Promise<boolean>); board?: ReturnType<typeof createBoard>; authenticate: Authenticate}): HttpHandler {
  return async (req, res) => {
    const send = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
      res.end(JSON.stringify({schemaVersion: 1, ...body}));
    };
    let requestOperation: keyof typeof boardRequestSchemas | undefined;
    let input: unknown;
    try {
      if (req.method !== 'POST') return send(405, {error: {code: 'METHOD_NOT_ALLOWED'}});
      const operation = new URL(req.url ?? '', 'http://board.invalid').pathname.slice('/api/board/'.length);
      const modern=operation.startsWith('v2/'),name=modern?operation.slice(3):operation;
      if (!Object.hasOwn(boardRequestSchemas, operation)) return send(404, {error: {code: 'NOT_FOUND'}});
      const principal = await authenticate(req);
      if (!principal) return send(401, {error: {code: 'AUTH_REQUIRED'}});
      admitActivity(principal);
      if (!board?.participate) return send(503, {error: {code: 'BOARD_UNAVAILABLE'}});
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        // Match the MCP transport's whole-request envelope, not a post-length cap.
        if (size > 65_536) return send(413, {error: {code: 'REQUEST_TOO_LARGE', message: 'The board request exceeds 65,536 bytes. Shorten the text or send fewer items per request.'}});
        chunks.push(chunk);
      }
      try {input = JSON.parse(Buffer.concat(chunks).toString());}
      catch {return send(400, {error: {code: 'INVALID_REQUEST', message: 'The board request body must be a valid JSON object. Check the JSON syntax and try again.'}});}
      activityInput(input);
      requestOperation = operation as keyof typeof boardRequestSchemas;
      const data = modern ? await board.agent[name as keyof typeof board.agent](principal,input) : operation === 'fetch' ? await board.fetch(principal, input) : operation === 'channels' ? await board.channels(principal,input) : operation === 'thread' ? await board.thread(principal,input) : operation === 'search' ? await board.search(principal,input) : await board.participate(principal, operation, input);
      if (operation === 'bootstrap' && data && typeof data === 'object' && (typeof sharedFiles === 'function' ? await sharedFiles(principal) : sharedFiles)) return send(200, {data: {...data, sharedFiles: true}});
      send(200, {data});
    } catch(caught){const error=serviceError(caught);
      if (requestOperation && error.name === 'ZodError') {
        const message = boardValidationMessage(requestOperation, input);
        if (message) return send(400, {error: {code: 'BOARD_REQUEST_FAILED', message}});
      }
      const status = error.status || 503;
      send(status, {error: {code: status >= 500 ? 'BOARD_UNAVAILABLE' : 'BOARD_REQUEST_FAILED',
        message: status < 500 ? error.message : 'The board is temporarily unavailable. Try again shortly. When retrying a post, reuse its original ID.'}});
    }
  };
}
