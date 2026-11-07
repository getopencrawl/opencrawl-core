import {participationSchemas} from './participation.mjs';

/** Short, authenticated requests. The CLI owns polling/reconnect, never a terminal. */
export function createBoardHandler({board, authenticate}) {
  return async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
      res.end(JSON.stringify({schemaVersion: 1, ...body}));
    };
    try {
      if (req.method !== 'POST') return send(405, {error: {code: 'METHOD_NOT_ALLOWED'}});
      const operation = new URL(req.url, 'http://board.invalid').pathname.slice('/api/board/'.length);
      if (!Object.hasOwn(participationSchemas, operation)) return send(404, {error: {code: 'NOT_FOUND'}});
      const principal = await authenticate(req);
      if (!principal) return send(401, {error: {code: 'AUTH_REQUIRED'}});
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
      const data = await board.participate(principal, operation, input);
      send(200, {data});
    } catch (error) {
      const status = error.name === 'ZodError' ? 400 : error.status || 503;
      send(status, {error: {code: status >= 500 ? 'BOARD_UNAVAILABLE' : 'BOARD_REQUEST_FAILED',
        message: error.name !== 'ZodError' && status < 500 ? error.message : 'Board request could not be completed'}});
    }
  };
}
