import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const scenario=process.argv[2],calls=[],closed=[];
const database={ready:async()=>{},close:async()=>closed.push('database')};
const context=vm.createContext({process:{argv:[],env:{},once(){},removeListener(){}},console,setInterval,clearInterval,performance});
let created=0;
async function createWorker(){
  if(++created===2)throw new Error('second worker unavailable');
  let state='INITIALIZED',finish;
  return {worker:{getState:()=>state,run(){calls.push('run');state='RUNNING';return new Promise(resolve=>{finish=resolve;});},shutdown(){calls.push('shutdown');state='STOPPED';finish();}},
    connection:{close:async()=>{assert.equal(state,'STOPPED','drain before closing the native connection');closed.push('native');}}};
}
const source={sourceId:'test',generation:'test',resolve(){},resolveDeletion(){}};
const modules={
  '../state/application.mjs':{createApplicationState:async()=>({})},
  '../state/settings.mjs':{applicationDatabase:()=>database},
  '../state/postgres.mjs':{requireApplicationStateReady:async()=>{if(scenario==='binding')throw new Error('migration incomplete');}},
  '../sessions/postgres-identities.mjs':{standaloneEventIdentities:()=>({ready:async()=>{},close:async()=>closed.push('events')})},
  '../identity/better-auth.mjs':{createLocalIdentity:async()=>({directory:{},ready:async()=>{},close:()=>closed.push('identity')})},
  './settings.mjs':{selfhostSettings:()=>({})},
  './services.mjs':{selfhostServices:()=>({ready:async()=>{},close:()=>closed.push('services')})},
  './indexing.mjs':{singleOrganizationSessionSource:()=>source},
  './temporal-settings.mjs':{selfhostTemporalSettings:()=>({namespace:'test'})},
  '../sessions/storage.mjs':{sessionStorage:()=>({store:{},prefix:'test'})},
  '../sessions/temporal/worker.mjs':{createSessionWorker:createWorker,buildSessionWorkflows:async()=>{}},
  '../connectors/temporal/worker.mjs':{createConnectorWorker:createWorker,buildConnectorWorkflows:async()=>{}},
  '../integrations/temporal/worker.mjs':{createIntegrationWorker:createWorker,buildIntegrationWorkflows:async()=>{}},
  '../integrations/temporal/client.mjs':{ensureIntegrationRecoverySchedule:async()=>{},ensureIntegrationDiscoverySchedule:async()=>{}},
  '../sessions/temporal/client.mjs':{ensureSessionSchedule:async()=>{calls.push('schedule');if(scenario==='schedule')throw new Error('schedule denied');},ensureSessionDeletionSchedule:async()=>{},activateSessionIndexing:async()=>{}},
  '../connectors/temporal/client.mjs':{connectorClient:async()=>({client:{},connection:{close:async()=>closed.push('scheduling')}})},
  'node:fs/promises':{mkdir:async()=>{},writeFile:async()=>{},unlink:async()=>{}},
  'node:url':{pathToFileURL:value=>new URL('file://'+value)},
  'node:timers/promises':{setTimeout:async()=>{}},
};
const entry=new vm.SourceTextModule(await readFile(new URL('../../dist/src/selfhost/worker.mjs',import.meta.url),'utf8'),{context});
await entry.link(specifier=>{const values=modules[specifier];assert.ok(values,specifier);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value);},{context});});
await entry.evaluate();
let error;try{await entry.namespace.runSelfhostWorker({});}catch(caught){error=caught.message;}
console.log(JSON.stringify({scenario,calls,closed,created,error}));
