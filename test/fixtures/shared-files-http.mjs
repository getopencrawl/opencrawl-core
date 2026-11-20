import {createServer} from 'node:http';
import {createSharedFilesHandler, sharedFilesAuthorization} from '../../dist/src/files/git-http.mjs';
import {fileRepositories} from '../../dist/src/files/store.mjs';

export const writers = {
  alice: {tenantId: 'team-a', userId: 'alice'},
  bob: {tenantId: 'team-a', userId: 'bob'},
  other: {tenantId: 'team-b', userId: 'alice'},
};
export function fixtureToken(name) { return 'fixture-token-' + name; }

export async function startFileServer(root, {store = fileRepositories(root, 'files-test'), beforeRevalidate, limits} = {}) {
  await store.ready();
  const revoked = new Set();
  const handler = createSharedFilesHandler({store,limits});
  const server = createServer(async (req, res) => {
    const header = sharedFilesAuthorization(req.headers.authorization);
    const who = Object.keys(writers).find(name => header === 'Bearer ' + fixtureToken(name));
    if (!who || revoked.has(who)) {
      res.writeHead(401, {'WWW-Authenticate': 'Basic realm="OpenCrawl shared files"'}).end();
      return;
    }
    await handler(req, res, writers[who], async () => {
      await beforeRevalidate?.(req, who, revoked);
      if (revoked.has(who)) throw Object.assign(new Error('access revoked'), {status:403});
    });
  });
  await new Promise((resolve,reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  return {origin:'http://127.0.0.1:' + server.address().port, store, revoked,
    async close() {
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }};
}
