import {readFile} from 'node:fs/promises';
import {createObjectStore, awsCredentials} from '../sessions/s3-store.mjs';
import {createConnectorSearch, connectorIndex} from './search.mjs';
import {createConnectorPipeline} from './pipeline.mjs';
import {validateBinding} from './scope.mjs';

/** Customer-owned local CLI, no hosted account. The config file is operator trusted. */
const [action, configPath, query] = process.argv.slice(2);
if (!['index', 'search'].includes(action) || !configPath) throw new Error('Usage: node src/connectors/standalone.mjs index|search config.json [query]');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const binding = validateBinding(config.binding);
const store = createObjectStore({...config.s3, credentials: awsCredentials()});
const search = createConnectorSearch({...config.search, tenantId: binding.tenantId, index: config.search.index || connectorIndex('selfhost', binding.tenantId, 'v4')});
await store.checkAccess(); await search.ensureIndex();
if (action === 'search') console.log(JSON.stringify(await search.search({tenantId: binding.tenantId}, [binding], {query}), null, 2));
else {
  const pipeline = createConnectorPipeline({binding, store, search});
  let cursor = null, objects = 0, records = 0;
  do {
    const page = await pipeline.listPage({cursor});
    for (const key of page.keys) { const result = await pipeline.processObject({key}); objects++; records += result.records; }
    cursor = page.cursor;
  } while (cursor);
  await search.refresh(); console.log(JSON.stringify({objects, records}));
}
