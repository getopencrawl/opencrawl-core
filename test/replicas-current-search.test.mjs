import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {applicationDatabaseFixture} from './fixtures/application-database.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
import {createReplicasImport} from '../dist/src/integrations/replicas-import.mjs';
import {replicasSession} from '../dist/src/integrations/replicas-events.mjs';
import {prepareReplicasThreads,saveReplicasThread} from '../dist/src/integrations/replicas-threads.mjs';
import {replicasOwnerId} from '../dist/src/identity/replicas.mjs';
import {createRealm} from '../dist/src/search/realm.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createContextCheck,lexicalCheckJudgment} from '../dist/src/search/check.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';

test('a Replicas agent excludes the provider copy of its chat and can still retrieve its sibling',async t=>{
  const database=await applicationDatabaseFixture(t);
  const directory=await mkdtemp(join(tmpdir(),'replicas-current-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const tenantId='internal', organizationId=randomUUID(),environmentId=randomUUID(), workspaceId=randomUUID();
  const principal={tenantId,userId:replicasOwnerId(organizationId,environmentId,workspaceId),owner:{kind:'shared',provider:'replicas',organizationId,environmentId,workspaceId}};
  const service=createReplicasImport({database,key:randomBytes(32),ingest:async()=>assert.fail(),schedule:async()=>assert.fail()});
  const options={endpoint:pathToFileURL(join(directory,'realm.sqlite')).href.replace('file:','sqlite:'),environment:'test'};
  const realm=createRealm({...options,tenantId});await realm.ensureIndex();
  const search=createWorkspaceSearch({sessions:createSessionSearch({...options,store:memorySessionStore(),prefix:'fixture'}),currentCapture:service.currentCapture});
  await prepareReplicasThreads(database.pool);
  for(const harness of ['codex','claude-code']){
    const sessionId=randomUUID(),currentSession={harness,sessionId};
    const provider=replicasSession(tenantId,organizationId,workspaceId,randomUUID());
    const peer=replicasSession(tenantId,organizationId,workspaceId,randomUUID());
    const external=replicasSession(tenantId,organizationId,randomUUID(),randomUUID());
    const bind=(resource,native,scope=tenantId)=>saveReplicasThread(database.pool,database.namespace,scope,resource.owner.userId,resource.sessionId,{harness,id:native});
    await bind(provider,sessionId);await bind(peer,randomUUID());await bind(external,sessionId);
    const topic=harness==='codex'?'cedar':'spruce';
    const doc=(id,resource)=>({id,document:{tenantId,userId:resource.owner.userId,harness:resource.harness,sessionId:resource.sessionId,
      installationId:resource.installationId,eventId:id,chunk:0,kind:'message',role:'assistant',private:false,text:harness+' evidence '+(resource===external?'other':topic)+' '+id,timestamp:'2026-11-15T00:00:00Z'}});
    const id=role=>harness+'-'+role;
    await realm.collection('session').bulk(principal,[doc(id('current'),provider),doc(id('peer'),peer),doc(id('external'),external)]);
    await realm.refresh(principal);
    const query={query:'evidence',source:'sessions',dedupe:false,groupBy:'none',currentSession};
    const ids=async(p,overrides={})=>(await search.search(p,{...query,...overrides})).results.map(row=>row.id);
    const check=createContextCheck({search,judge:lexicalCheckJudgment,authorize:async()=>{}});
    const suggested=await check(principal,{eventId:'check',currentSession,message:topic,timestamp:new Date().toISOString()});
    assert.deepEqual(suggested.results.map(r=>r.id),['sessions:'+id('peer')]);
    const defaultHits=await ids(principal);
    assert.ok(!defaultHits.includes('sessions:'+id('current')),'own provider chat appeared in native search');
    assert.ok(defaultHits.includes('sessions:'+id('peer')));assert.ok(defaultHits.includes('sessions:'+id('external')));
    assert.ok((await ids(principal,{includeCurrentSession:true})).includes('sessions:'+id('current')));
    assert.ok((await ids({tenantId,userId:'human'})).includes('sessions:'+id('current')));
    await assert.rejects(search.search(principal,{...query,currentCapture:peer}),{status:400});
    assert.equal(await service.currentCapture({...principal,tenantId:'other'},currentSession),undefined);
    assert.equal(await service.currentCapture({...principal,owner:{...principal.owner,organizationId:randomUUID()}},currentSession),undefined);
    await bind(replicasSession(tenantId,organizationId,workspaceId,randomUUID()),sessionId);
    assert.equal(await service.currentCapture(principal,currentSession),undefined,'two provider chats claimed the same native thread');
  }
});
