import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assertApplicationSource} from '../../dist/src/state/runtime.mjs';
import {validateBinding} from '../../dist/src/connectors/scope.mjs';
const scenario=process.argv[2],calls=[],closed=[];
const config={binding:{tenantId:scenario==='tenant'?'org_foreign':'org_expected',connectionId:'int_fixture',provider:'github',workspaceId:'workspace',access:'workspace-global',rawPrefix:'raw/v1/source=github/workspace=workspace/connection=int_fixture/'},s3:{bucket:scenario==='bucket'?'foreign':'expected'},search:{endpoint:'https://search.invalid'},temporal:{address:'temporal.invalid:7233',namespace:'default',taskQueue:'test'}};
const application={database:{sourceIdentity:{version:1,bucket:'expected',prefix:'capture',organizationId:'org_expected'}},state:{},close:async()=>closed.push('application')};
const context=vm.createContext({process:{argv:['node','standalone.mjs','fixture.json','bundle.cjs'],once(){},removeListener(){}},console});
const modules={
  '../../state/runtime.mjs':{openApplicationState:async()=>application,assertApplicationSource},
  '../write-barrier.mjs':{guardConnectorWrites:()=>assert.fail('No activity should run in this bootstrap test')},
  '../../search/realm.mjs':{realmIndex:()=> 'index'},
  'node:fs/promises':{readFile:async()=>JSON.stringify(config)},
  '../../sessions/s3-store.mjs':{awsCredentials:()=>({}),createObjectStore:options=>({bucket:options.bucket,checkAccess:async()=>calls.push('object-access')})},
  '../search.mjs':{createConnectorSearch:()=>({ensureIndex:async()=>calls.push('search-index')})},
  '../scope.mjs':{validateBinding},
  './worker.mjs':{buildConnectorWorkflows:async()=>calls.push('bundle'),createConnectorWorker:async()=>({worker:{run:async()=>calls.push('worker'),shutdown(){}},connection:{close:async()=>closed.push('worker')}})},
  './client.mjs':{connectorClient:async()=>({client:{},connection:{close:async()=>closed.push('client')}}),ensureConnectorSchedule:async()=>{calls.push('schedule');if(scenario==='schedule-failure')throw new Error('schedule unavailable');}},
};
const entry=new vm.SourceTextModule(await readFile(new URL('../../dist/src/connectors/temporal/standalone.mjs',import.meta.url),'utf8'),{context});
await entry.link(specifier=>{const values=modules[specifier];assert.ok(values,specifier);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value);},{context});});
let error;try{await entry.evaluate();}catch(caught){error=caught.message;}
console.log(JSON.stringify({calls,closed,error}));
