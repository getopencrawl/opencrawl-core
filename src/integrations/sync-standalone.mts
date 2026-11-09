import {standaloneStorage} from '../sessions/standalone.mjs';
import {createRegistry} from './registry.mjs';
import {createSourceSync} from './sync.mjs';

// Compose service `sources-sync`: polls the registry and syncs due connections.
const env = process.env;
if (!env.OPENCRAWL_SOURCES_PATH || !env.OPENCRAWL_SOURCES_MANIFESTS) throw new Error('Set OPENCRAWL_SOURCES_PATH and OPENCRAWL_SOURCES_MANIFESTS');
const registry = createRegistry(env.OPENCRAWL_SOURCES_PATH);
const {store} = standaloneStorage(env);
await store.checkAccess();
const sync = createSourceSync({registry, store, manifests: env.OPENCRAWL_SOURCES_MANIFESTS, composioApiKey: env.COMPOSIO_API_KEY || undefined,
  composioBaseUrl: env.COMPOSIO_BASE_URL || undefined, log: (event, data) => console.log(JSON.stringify({event, ...data}))});
const poll = Number(env.OPENCRAWL_SOURCES_POLL_MS || 30_000);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; });
while (!stopping) {
  await sync.tick({shouldStop: () => stopping}).catch(error => console.error(JSON.stringify({event: 'sources.tick_failed', message: String((error as Error).message).slice(0, 300)})));
  for (let waited = 0; waited < poll && !stopping; waited += 1000) await new Promise(resolve => setTimeout(resolve, 1000));
}
registry.close();
