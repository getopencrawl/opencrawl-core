/** Disposable branch-verification server. Run only against a dedicated test DB.
 * Production uses server.mts and durable Temporal dispatch. This preview indexes
 * synchronously into its own SQLite realm for a visible end-to-end assertion. */
import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createApplicationDatabase} from '../src/state/postgres.mjs';
import {createPostgresBoardState} from '../src/state/board.mjs';
import {createLocalIdentity} from '../src/identity/better-auth.mjs';
import {createLocalSessionStore} from '../src/sessions/local-store.mjs';
import {createSessionIngest} from '../src/sessions/ingest.mjs';
import {createSessionSearch} from '../src/sessions/search.mjs';
import {createSessionPipeline} from '../src/sessions/indexer.mjs';
import {createOnboardingStatus} from '../src/onboarding-status.mjs';
import {createReplicasImport} from '../src/integrations/replicas-import.mjs';
import {selfhostApplication} from '../src/selfhost/application.mjs';

const connectionString=process.env.OPENCRAWL_TEST_POSTGRES_URL,root=process.env.REPLICAS_PREVIEW_ROOT;
if(!connectionString||!root||!root.startsWith('/private/tmp/replicas-backfill-'))throw new Error('Use a task-owned disposable test database and scratch directory');
const expectedOrganization=process.env.REPLICAS_PREVIEW_ORGANIZATION_ID;
if(!expectedOrganization||!/^[-a-f0-9]{36}$/.test(expectedOrganization))throw new Error('Set the exact Replicas organization ID authorized for this test');
await mkdir(root,{recursive:true,mode:0o700});
const origin='http://localhost:48471',tenantId='org_replicaspreview',prefix='replicas-preview/v1';
const database=createApplicationDatabase({connectionString,namespace:'replicas-preview-'+randomUUID()});await database.ready();
const board=createPostgresBoardState(database);await board.ready();
const secret=randomBytes(32).toString('hex'),setup=randomBytes(32).toString('hex');
const identity=await createLocalIdentity({url:origin,secret,database,organizationId:tenantId});await identity.ready();
const store=createLocalSessionStore(resolve(root,'objects'));
const searchOptions={endpoint:'sqlite://'+resolve(root,'search.sqlite'),environment:'replicas-preview',tenantId};
const search=createSessionSearch({...searchOptions,store,prefix});
const pipeline=createSessionPipeline({store,prefix,search,resolvePrincipal:async({batch})=>{if(batch.owner.tenantId!==tenantId)throw new Error('Preview tenant mismatch');return batch.owner;}});
const imports=createReplicasImport({database,key:randomBytes(32),ingest:createSessionIngest({store,prefix,scheduleIndexing:key=>pipeline.processObject({key})}).putBatch,request:async(url,options)=>{
  const response=await fetch(url,options);
  if(!response.ok)console.log(JSON.stringify({upstreamStatus:response.status,path:new URL(String(url)).pathname}));
  if(String(url).endsWith('/whoami')&&response.ok){const value:unknown=await response.clone().json();if(!value||typeof value!=='object'||!('organization' in value)||!value.organization||typeof value.organization!=='object'||!('id' in value.organization)||value.organization.id!==expectedOrganization)throw new Error('Preview only permits the explicitly selected Replicas organization');}
  return response;
}});
const app=selfhostApplication({settings:{organizationId:tenantId,url:origin,authOrigin:origin+'/api/auth',clientId:'opencrawl-cli',authSecret:secret,setupToken:setup,registryPath:'unused',search:searchOptions},store,prefix,identity,boardState:{namespace:database.namespace,board},replicasImport:imports});
let loginCookies:string[]=[];
const server=createServer((req,res)=>{
  // One-shot loopback fixture login, using cookies from the real signup path.
  if(req.method==='GET'&&req.url==='/__branch_test_login'&&loginCookies.length){const cookies=loginCookies;loginCookies=[];res.writeHead(303,{'set-cookie':cookies,location:'/sources'});res.end();return;}
  void app(req,res);
});
await new Promise<void>(done=>server.listen(48471,'127.0.0.1',done));
const signed=await fetch(origin+'/auth/signup',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({setup,workspace:'Replicas branch verification',name:'Branch verification admin',email:'replicas-preview@example.test',password:randomBytes(24).toString('hex')})});
if(signed.status!==303)throw new Error('Preview admin setup failed');loginCookies=signed.headers.getSetCookie();
const [admin]=(await identity.directory.userManagement.listOrganizationMemberships({organizationId:tenantId})).data;
const principal={tenantId,userId:admin!.userId},onboarding=createOnboardingStatus({store,prefix});
await onboarding.cli(principal);await onboarding.mcpTest(principal);await onboarding.session(principal,{schemaVersion:1,installationId:'fixture',sessionId:'fixture',origin:'unknown',owner:principal,attachments:[],harness:'codex',events:[{id:'fixture',kind:'message'}]});await onboarding.complete(principal);
await writeFile(resolve(root,'preview-state.json'),JSON.stringify({namespace:database.namespace,tenantId,admin:principal.userId,expectedOrganization}),{mode:0o600});
console.log('Branch verification server ready on port 48471. Only the explicitly selected Replicas organization is accepted.');
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{server.closeAllConnections();server.close(()=>{identity.close();void database.close();});});
