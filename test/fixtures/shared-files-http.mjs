import {createServer} from 'node:http';
import {createSharedFilesHandler, sharedFilesAuthorization} from '../../dist/src/files/git-http.mjs';

export const writers = {
  alice: {tenantId: 'team-a', userId: 'alice'},
  bob: {tenantId: 'team-a', userId: 'bob'},
  other: {tenantId: 'team-b', userId: 'alice'},
};
export function fixtureToken(name) { return 'fixture-token-' + name; }

export async function startFileServer(root) {
  const history = new Map();
  const revoked = new Set();
  const audit = [];
  const store = {
    async read(tenant) {return history.get(tenant) ?? null;},
    async publish(tenant, expected, next, user) {
      if ((history.get(tenant)?.head ?? null) !== expected) return false;
      history.set(tenant, next);
      audit.push({tenant, expected, head: next.head, user});
      return true;
    },
  };
  const handler = createSharedFilesHandler({root, store});
  const server = createServer(async (req, res) => {
    const header = sharedFilesAuthorization(req.headers.authorization);
    const who = Object.keys(writers).find(name => header === 'Bearer ' + fixtureToken(name));
    if (!who || revoked.has(who)) {
      res.writeHead(401, {'WWW-Authenticate': 'Basic realm="OpenCrawl shared files"'}).end();
      return;
    }
    await handler(req, res, writers[who], async () => {
      if (revoked.has(who)) throw Object.assign(new Error('access revoked'), {status:403});
    });
  });
  await new Promise((resolve,reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  return {origin:'http://127.0.0.1:' + server.address().port, history, audit, store, revoked,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }};
}
