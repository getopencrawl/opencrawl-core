import type {ConnectorBinding} from './types.mjs';
import type {RealmOptions} from '../search/types.mjs';
import type {SourceProgress} from './workflow.mjs';
import {guardConnectorWrites} from './write-barrier.mjs';
import {realmIndex} from '../search/realm.mjs';
import {readFile} from 'node:fs/promises';
import {createObjectStore, awsCredentials} from '../sessions/s3-store.mjs';
import {createConnectorSearch} from './search.mjs';
import {createConnectorPipeline} from './pipeline.mjs';
import {validateBinding} from './scope.mjs';
import {sourcePaginationProgress, advanceSourcePagination} from './workflow.mjs';

/** Customer-owned local CLI, no hosted account. The config file is operator trusted. */
const [action, configPath, query] = process.argv.slice(2);
if (!['index', 'search'].includes(action) || !configPath) throw new Error('Usage: node src/connectors/standalone.mjs index|search config.json [query]');
const config = JSON.parse(await readFile(configPath, 'utf8')) as {binding: ConnectorBinding; s3: Parameters<typeof createObjectStore>[0]; search: RealmOptions};
const binding = validateBinding(config.binding);
const store = createObjectStore({...config.s3, credentials: awsCredentials()});
const search = createConnectorSearch({...config.search, tenantId: binding.tenantId, index: config.search.index || realmIndex('selfhost', binding.tenantId)});
await store.checkAccess(); await search.ensureIndex();
if (action === 'search') console.log(JSON.stringify(await search.search({tenantId: binding.tenantId}, [binding], {query}), null, 2));
else {
  const pipeline = createConnectorPipeline({binding, ...guardConnectorWrites({binding, store, search})});
  let cursor: string | null = null; let objects = 0, records = 0;
  let progress: SourceProgress | null = sourcePaginationProgress();
  do {
    const page = await pipeline.listPage({cursor});
    progress = advanceSourcePagination(progress, page);
    for (const key of page.keys) { const result = await pipeline.processObject({key}); objects++; records += result.records; }
    cursor = page.cursor;
  } while (cursor);
  await search.refresh(); console.log(JSON.stringify({objects, records}));
}
