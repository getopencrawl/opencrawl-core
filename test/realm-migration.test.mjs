import {test} from 'node:test';
import assert from 'node:assert/strict';
import {migrateRealmCorpus,documentDigest} from '../dist/src/search/migration.mjs';
const principal={tenantId:'org-a',userId:'system'},corpus='session';
test('migration verifies full content before checkpointing; restart replays uncommitted pages without duplication',async()=>{
 const docs=Array.from({length:3},(_,i)=>({id:String(i),document:{tenantId:'org-a',text:'complete '+i}})),written=new Map();let checkpoint=null,interrupt=true,version='frozen-version';
 const source={identity:'legacy:org-a',version:async()=>version,read:async after=>({total:3,documents:docs.slice(after||0,(after||0)+2),next:Math.min((after||0)+2,3)})};
 const collection={bulk:async(_,items)=>{for(const d of items)written.set(d.id,d.document);if(interrupt){interrupt=false;throw new Error('Interrupted');}},
 mget:async(_,ids)=>({docs:ids.map(id=>({_id:id,found:true,_source:written.get(id)}))}),search:async()=>({hits:{total:{relation:'eq',value:written.size}}})};
 const realm={identity:'realm:org-a',scope:p=>assert.equal(p.tenantId,'org-a'),collection:()=>collection,ensureIndex:async()=>{},refresh:async()=>{}};
 const options={principal,corpus,source,realm,load:async()=>checkpoint,save:async s=>{checkpoint=s;}};
 await assert.rejects(migrateRealmCorpus(options),/Interrupted/);assert.equal(checkpoint,null);
 const result=await migrateRealmCorpus(options);assert.equal(result.complete,true);assert.equal(result.copied,3);assert.equal(written.size,3);
 version='changed';await assert.rejects(migrateRealmCorpus(options),/version changed/);
 assert.equal(documentDigest({b:2,a:1}),documentDigest({a:1,b:2}));
});
test('a destination that silently loses content is never checkpointed',async()=>{
 let checkpoint;
 const source={identity:'source',version:async()=>'v1',read:async()=>({total:1,documents:[{id:'one',document:{tenantId:'org-a',text:'complete text'}}],next:['one']})};
 const realm={identity:'target',scope:()=>{},ensureIndex:async()=>{},collection:()=>({bulk:async()=>{},mget:async()=>({docs:[{_id:'one',found:true,_source:{tenantId:'org-a',text:'truncated'}}]})})};
 await assert.rejects(migrateRealmCorpus({principal,corpus,source,realm,load:async()=>null,save:async s=>{checkpoint=s;}}),/verification failed/);assert.equal(checkpoint,undefined);
});
