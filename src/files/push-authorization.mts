import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {fileURLToPath} from 'node:url';

// Git runs pre-receive after unpacking into quarantine. Give only that process
// a single-use loopback callback to the original authenticated HTTP request.
export async function pushAuthorization(check: () => Promise<void>) {
  const key = randomBytes(32).toString('hex');
  let used = false;
  const server = createServer(async (req, res) => {
    if (used || req.method !== 'POST' || req.url !== '/' + key) {
      res.writeHead(403).end();
      return;
    }
    used = true;
    try {
      await check();
      res.writeHead(204).end();
    } catch {
      res.writeHead(403).end();
    }
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    env: {
      OPENCRAWL_GIT_CHECK: 'http://127.0.0.1:' + address.port + '/' + key,
      OPENCRAWL_GIT_NODE: process.execPath.replaceAll('\\', '/'),
      OPENCRAWL_GIT_HELPER: fileURLToPath(new URL('./authorize-push.mjs', import.meta.url)).replaceAll(
        '\\',
        '/'
      )
    },
    close() {
      server.close();
      server.closeAllConnections();
    }
  };
}
