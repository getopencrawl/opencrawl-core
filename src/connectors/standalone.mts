import type {ConnectorBinding} from './types.mjs';
import type {RealmOptions} from '../search/types.mjs';
import type {ConnectionReference} from './temporal/types.mjs';
import type {connectorClient as ClientFactory} from './temporal/client.mjs';
import {realmIndex} from '../search/realm.mjs';
import {readFile} from 'node:fs/promises';
import {createConnectorSearch} from './search.mjs';
import {validateBinding} from './scope.mjs';
import {connectorClient,startConnectorIndexing} from './temporal/client.mjs';

/** Read-only search stays local; indexing always executes durably on Temporal. */
const [action,configPath,query]=process.argv.slice(2);
if(!['index','search'].includes(action)||!configPath)throw new Error('Usage: node dist/src/connectors/standalone.mjs index|search config.json [query]');
const config=JSON.parse(await readFile(configPath,'utf8')) as {reference?:ConnectionReference;binding:ConnectorBinding;search:RealmOptions;temporal:Parameters<typeof ClientFactory>[0]&{taskQueue:string};generation?:string};
if(action==='index'){
 const reference=config.reference||config.binding;
 if(!reference||!config.temporal?.taskQueue)throw new Error('Configure a trusted connection reference and Temporal indexing task queue');
 const runtime=await connectorClient(config.temporal);
 try {const result=await startConnectorIndexing(runtime.client,{reference,taskQueue:config.temporal.taskQueue,generation:config.generation});console.log(JSON.stringify(result));if(!result.submitted)process.exitCode=2;}
 finally {await runtime.connection.close();}
} else {
 const binding=validateBinding(config.binding),search=createConnectorSearch({...config.search,tenantId:binding.tenantId,index:config.search.index||realmIndex('selfhost',binding.tenantId)});
 console.log(JSON.stringify(await search.search({tenantId:binding.tenantId},[binding],{query}),null,2));
}
