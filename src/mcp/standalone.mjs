import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createOpenCrawlMcp} from './server.mjs';

export function standaloneMcp({token, origin, revision}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('Set MCP_TOKEN to a random secret of at least 32 characters');
  const expected = Buffer.from('Bearer ' + token);
  const mcp = createOpenCrawlMcp({origin, revision, authenticate: async req => {
    const actual = Buffer.from(req.headers.authorization || '');
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? {userId: 'local-operator'} : null;
  }});
  const server = createServer((req, res) => {
    if (req.headers.host !== new URL(origin).host) {res.writeHead(403); return res.end();}
    if (req.url !== '/mcp') {res.writeHead(404); return res.end();}
    mcp(req, res).catch(() => {if (!res.headersSent) res.writeHead(503);res.end();});
  });
  server.on('close', () => mcp.close());
  server.requestTimeout = 15000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8093);
  const server = standaloneMcp({token: process.env.MCP_TOKEN, origin: process.env.MCP_ORIGIN || `http://127.0.0.1:${port}`});
  server.listen(port, '127.0.0.1');
  process.on('SIGTERM', () => server.close());
}
