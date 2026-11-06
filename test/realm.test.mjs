import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRealm,realmDocument,realmIndex,realmMapping} from '../src/search/realm.mjs';
const principal={tenantId:'org-a',userId:'user-a'};
test('one namespace per organization and environment; common envelope retains native precision without duplicate bodies',()=>{
  assert.notEqual(realmIndex('production','org-a'),realmIndex('production','org-b'));
  assert.notEqual(realmIndex('staging','org-a'),realmIndex('production','org-a'));
  const d=realmDocument('connector','id',{tenantId:'org-a',provider:'slack',kind:'message',timestamp:'1700000000.123456',text:'full message',title:'Title',authorId:'U123',sourceKey:'raw/key'});
  assert.deepEqual({tenantId:d.tenantId,corpus:d.corpus,id:d.id,source:d.source,kind:d.kind,timestamp:d.timestamp,author:d.author},
    {tenantId:'org-a',corpus:'connector',id:'id',source:'slack',kind:'message',timestamp:'2023-11-14T22:13:20.123Z',author:'U123'});
  assert.equal(d.connector.timestamp,'1700000000.123456');assert.equal(d.text,'full message');assert.equal(d.connector.text,undefined);assert.equal(d.connector.tenantId,undefined);
});
test('realm pin rejects foreign tenant mapping; reads, writes and identities fail closed across corpora',async()=>{
  const requests=[];let mappingTenant='org-b';let hit={_id:'session:shared',_source:{schema:1,tenantId:'org-a',corpus:'session',id:'shared',session:{userId:'user-a'},text:'session'}};
  const realm=createRealm({endpoint:'http://search.test',tenantId:'org-a',index:'test',fetch:async(url,options)=>{
    requests.push({url:String(url),body:options.body&&JSON.parse(options.body)});
    if(url.pathname.endsWith('_mapping'))return Response.json({test:{mappings:{...realmMapping,_meta:{schema:1,tenantId:mappingTenant}}}});
    if(url.pathname.endsWith('_search'))return Response.json({timed_out:false,_shards:{failed:0},hits:{total:{value:1,relation:'eq'},hits:[hit]}});
    return Response.json({acknowledged:true});
  }});
  await assert.rejects(realm.ensureIndex(),/tenant mismatch/);mappingTenant='org-a';await realm.ensureIndex();
  const session=realm.collection('session');
  assert.equal((await session.search(principal,{query:{match_all:{}}})).hits.hits[0]._source.text,'session');
  assert.deepEqual(requests.at(-1).body.query.bool.filter,[{term:{tenantId:'org-a'}},{term:{corpus:'session'}}]);
  await assert.rejects(session.search({...principal,tenantId:'org-b'},{}),/scope/);
  await assert.rejects(session.bulk(principal,[{id:'shared',document:{tenantId:'org-b',text:'foreign'}}]),/scope/);
  await assert.rejects(realm.collection('board').search(principal,{}),/scope/);
  hit={...hit,_id:'session:wrong'};await assert.rejects(session.search(principal,{}),/scope/);
});

test('OpenSearch signatures match AWS botocore for reserved and already escaped path characters',async()=>{
 const {signRequest}=await import('../src/sessions/s3-store.mjs');
 // Golden signatures generated with AWS CLI 2.36.49's botocore SigV4Auth, fixed test credentials/time.
 for(const [path,signature] of [['/_doc/connector:abc','386bca5e5360ef402d1d8bc4e7309861c29ef0ae6ff3c024361c8b435f229351'],['/index-%2A/_search','ed7a754a350a16007ee86eac0fe52125f39933abacc581044b4703773f9ffe65']]){
  const signed=signRequest({method:'GET',url:new URL('https://search.example.com'+path),accessKeyId:'test-key',secretAccessKey:'test-secret',region:'us-west-2',service:'es',date:new Date('2026-11-06T00:00:00Z')});
  assert.ok(signed.authorization.endsWith('Signature='+signature));
 }
});
