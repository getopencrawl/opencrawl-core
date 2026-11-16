import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createOnlineObjectPolicy,verifyOnlineNativeDeletionProof} from '../dist/src/state/online-object-policy.mjs';
import {createBoundObjectMigration} from '../dist/src/state/object-migration.mjs';
import {createOnlineMigrationObjectStore} from '../dist/src/state/online-object-store.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex'),prefix='sessions/production/v1',agentPrefix=prefix+'/_agent-access';
const owner={tenantId:'org_policy',userId:'user_policy'},id=hash('credential'),scope='tenants/'+hash(owner.tenantId)+'/users/'+hash(owner.userId);
const credential={schemaVersion:1,id,principal:owner,expiresAt:'2099-01-01T00:00:00.000Z',revoked:false,generation:hash('generation')};
const marker=prefix+'/'+scope+'/codex/'+hash('session')+'/'+hash('directory')+'/event-identities-v1.json';
const native=()=>({applicationNamespace:'application',databaseId:randomUUID(),namespace:'bucket',bucket:'bucket',sourceContractHash:hash('native owning contract'),verifierId:'native-metadata-v1'});
test('explicit nested agent route shares one physical root and preserves purpose-aware owning decoder identities',()=>{
 const policy=createOnlineObjectPolicy({prefix,agentPrefix});assert.equal(policy.roots.filter(x=>x.startsWith(prefix)).length,1);
 const options={database:{namespace:'application'},store:{bucket:'bucket'},tenantIds:[owner.tenantId],registryRecords:[],eventIdentities:{}};
 const targets=[];for(const route of policy.routes){const decoder=createBoundObjectMigration({...options,...route}),key=route.prefix+'/_credentials/'+id+'.json';assert.equal(policy.classify(key).domain,'capture-credentials');const value=decoder.decodeOnline(key,Buffer.from(JSON.stringify(credential)));assert.equal(value.record.purpose,route.credentialPurpose);targets.push(JSON.stringify([value.domain,...value.identity]));}
 assert.notEqual(targets[0],targets[1]);assert.equal(policy.route(agentPrefix+'/_credential-generations/'+scope+'.json').credentialPurpose,'agent');
 assert.throws(()=>policy.classify(agentPrefix+'/board/tenants/'+hash(owner.tenantId)+'.json'),/unrelated application state/);
 assert.throws(()=>createOnlineObjectPolicy({prefix}).classify(agentPrefix+'/_credentials/'+id+'.json'),/Unrecognized/);
 assert.throws(()=>createOnlineObjectPolicy({prefix,agentPrefix:prefix+'/other'}),/unsupported agent namespace/);
});
test('native binding changes policy identity; exact legacy marker classification stays explicit and immutable',()=>{
 const binding=native(),policy=createOnlineObjectPolicy({prefix,agentPrefix,preservedEventIdentities:binding}),before=policy.policyHash;
 assert.equal(policy.classify(marker).preservedNative,true);assert.equal(policy.classify(marker).domain,'event-identities');assert.equal(policy.classify(prefix+'/_credentials/'+id+'.json').preservedNative,undefined);
 assert.equal(createOnlineObjectPolicy({prefix}).classify(marker).preservedNative,undefined);
 binding.databaseId=randomUUID();assert.equal(policy.policyHash,before);assert.notEqual(createOnlineObjectPolicy({prefix,agentPrefix,preservedEventIdentities:binding}).policyHash,before);
 assert.notEqual(createOnlineObjectPolicy({prefix,preservedEventIdentities:policy.preservedEventIdentities}).policyHash,before);
 assert.throws(()=>policy.classify(marker.replace('event-identities-v1','event-identities-v2')),/Unrecognized/);
 assert.throws(()=>policy.classify(marker.replace(prefix+'/',agentPrefix+'/')),/Agent credential source contains unrelated application state/);
 assert.throws(()=>createOnlineObjectPolicy({prefix,preservedEventIdentities:{...native(),extra:true}}),/invalid native binding/);
 assert.throws(()=>createOnlineObjectPolicy({prefix,credentialPurpose:'agent',preservedEventIdentities:native()}),/capture scope/);
});
test('preserved native listing reads no bodies; direct reads and every mutation fail before raw, authority or journal dispatch',async()=>{
 const policy=createOnlineObjectPolicy({prefix,preservedEventIdentities:native()}),calls=[];
 const denied=async()=>{calls.push('denied-dispatch');assert.fail('native path dispatched IO');};
 const raw={bucket:'bucket',get:denied,has:denied,readVersion:denied,put:denied,compareAndSet:denied,delete:denied,listPage:async()=>({keys:[marker],nextToken:'original'}),purgePrefix:async(_prefix,options)=>{options.select(marker);await options.beforeDelete(marker,denied);}};
 const store=createOnlineMigrationObjectStore({raw,external:{read:denied,putIfVersion:denied,deleteIfVersion:denied},journal:{mutate:denied,reconcile:denied},writeAuthority:{run:denied},sourceId:'source',classify:policy.classify});
 assert.deepEqual(await store.listPage(prefix,{maxKeys:1}),{keys:[marker],nextToken:'original'});
 for(const read of [()=>store.get(marker),()=>store.has(marker),()=>store.readVersion(marker),async()=>{for await(const ignored of store.read(marker))void ignored;}])await assert.rejects(read,/PRESERVED_NATIVE_BODY_DENIED/);
 for(const write of [()=>store.put(marker,Buffer.from('arbitrary')),()=>store.compareAndSet(marker,null,Buffer.from('arbitrary')),()=>store.delete(marker)])await assert.rejects(write,/PRESERVED_NATIVE_MUTATION_DENIED/);
 await assert.rejects(store.purgePrefix(prefix),/MUTABLE_PHYSICAL_PURGE_DENIED/);assert.deepEqual(calls,[]);
});
test('native marker is optional true only and raw immutable methods remain unchanged',async()=>{
 let writes=0;const raw={get:async()=>Buffer.from('raw'),put:async()=>{writes++;},listPage:async()=>({keys:[],nextToken:null})};
 const bad=createOnlineMigrationObjectStore({raw,external:{},sourceId:'source',classify:()=>({maxBytes:1,preservedNative:false})});await assert.rejects(bad.get('key'),/INVALID_CLASSIFICATION/);
 const good=createOnlineMigrationObjectStore({raw,external:{},sourceId:'source',classify:createOnlineObjectPolicy({prefix,preservedEventIdentities:native()}).classify});
 const rawKey=prefix+'/'+scope+'/attachments/'+hash('attachment');assert.equal((await good.get(rawKey)).toString(),'raw');await good.put(rawKey,Buffer.from('same'));assert.equal(writes,1);
});

test('native absence capability is policy-bound and only exact current tombstone metadata explains erasure',()=>{
 const binding=native(),source=marker.slice(0,-'event-identities-v1.json'.length),policy=createOnlineObjectPolicy({prefix,preservedEventIdentities:binding});
 const versioned={...binding,deletionProofVersion:1},enabled=createOnlineObjectPolicy({prefix,preservedEventIdentities:versioned});assert.notEqual(enabled.policyHash,policy.policyHash);assert.notEqual(enabled.nativeBindingHash,policy.nativeBindingHash);
 const resource=source.replace(/\/[a-f0-9]{64}\/([a-f0-9]{64})\/$/,'/$1/');
 const proof={format:1,kind:'native-event-identity-deletion',databaseId:binding.databaseId,namespace:binding.namespace,source,resource,deleted:true,sessionsAbsent:true,metadataOnly:true,eventRowsRead:false};
 assert.equal(verifyOnlineNativeDeletionProof(null,{binding:versioned,prefix,source}),false);assert.equal(verifyOnlineNativeDeletionProof(proof,{binding:versioned,prefix,source}),true);
 for(const change of [{databaseId:randomUUID()},{namespace:'foreign'},{source:source+'foreign/'},{resource:resource+'other/'},{deleted:false},{sessionsAbsent:false},{metadataOnly:false},{eventRowsRead:true},{format:2},{kind:'anything'},{bodyHash:hash('invented')}])assert.throws(()=>verifyOnlineNativeDeletionProof({...proof,...change},{binding:versioned,prefix,source}),/invalid native deletion proof/);
 assert.throws(()=>verifyOnlineNativeDeletionProof(proof,{binding,prefix,source}),/invalid native deletion proof/);assert.throws(()=>createOnlineObjectPolicy({prefix,preservedEventIdentities:{...binding,deletionProofVersion:2}}),/invalid native binding/);
});
