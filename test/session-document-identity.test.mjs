import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRealm,realmDocument} from '../dist/src/search/realm.mjs';
import {batchDocuments,sessionDocumentId} from '../dist/src/sessions/indexer.mjs';
import {migrateSessionDocumentIds,restoreSessionDocumentIds} from '../dist/src/sessions/document-identity.mjs';
import {sessionScope} from '../dist/src/sessions/ingest.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const owner={tenantId:'org_a',userId:'user_a'},teammate={tenantId:'org_a',userId:'user_b'};
// The pre-migration document ID included the uploading installation.
const legacyId=(who,d)=>digest(JSON.stringify([sessionScope(who),d.harness,d.installationId,d.sessionId,d.eventId,d.chunk]));
const doc=(who,fields)=>({tenantId:who.tenantId,userId:who.userId,harness:'codex',origin:'desktop',sessionId:'s1',kind:'tool_call',role:null,
  sequence:100,chunk:0,nativeId:'fc_1',timestamp:'2026-10-23T07:51:12.957Z',receivedAt:'2026-11-06T05:09:44.313Z',text:'',toolNames:['exec'],
  toolCallId:'call_1',parentId:null,turnId:null,sourceKey:'k',installationId:'install-a',eventId:'legacy-1',...fields});

/** Just enough OpenSearch for a sorted scan plus bulk index/delete on one index. */
function engine(){
  const docs=new Map();
  const value=(source,path)=>path.split('.').reduce((v,k)=>v?.[k],source);
  const compare=(a,b)=>a===b?0:a==null?1:b==null?-1:a<b?-1:1;
  async function fetch(url,{method,body}){
    const path=new URL(url).pathname;
    if(path.endsWith('/_bulk')){
      const lines=body.trim().split('\n').map(line=>JSON.parse(line)),items=[];
      for(let i=0;i<lines.length;i++){
        const [op,meta]=Object.entries(lines[i])[0];
        if(op==='delete'){const found=docs.delete(meta._id);items.push({delete:{status:found?200:404}});}
        else {docs.set(meta._id,lines[++i]);items.push({[op]:{status:201}});}
      }
      return Response.json({errors:false,items});
    }
    if(path.endsWith('/_search')&&method==='POST'){
      const query=JSON.parse(body),filters=query.query.bool.filter;
      const fields=query.sort.map(entry=>Object.keys(entry)[0]);
      const key=source=>fields.map(field=>{const v=value(source,field);return field.endsWith('.timestamp')&&v!=null?Date.parse(v):v??null;});
      let rows=[...docs.entries()].filter(([,s])=>filters.every(f=>Object.entries(f.term).every(([k,v])=>s[k]===v)))
        .map(([id,s])=>({_id:id,_source:s,_score:null,sort:key(s)}))
        .sort((a,b)=>{for(let i=0;i<fields.length;i++){const c=compare(a.sort[i],b.sort[i]);if(c)return c;}return 0;});
      if(query.search_after)rows=rows.filter(row=>{for(let i=0;i<fields.length;i++){const c=compare(row.sort[i],query.search_after[i]);if(c)return c>0;}return false;});
      return Response.json({timed_out:false,_shards:{failed:0},hits:{total:{value:rows.length,relation:'eq'},hits:rows.slice(0,query.size)}});
    }
    throw new Error('unexpected request '+method+' '+path);
  }
  const put=(id,flat)=>docs.set('session:'+id,realmDocument('session',id,flat));
  const flat=()=>[...docs.entries()].map(([id,s])=>({id:id.slice(8),...s.session,text:s.text}));
  return {docs,fetch,put,flat};
}
function setup(){
  const e=engine();
  const realm=createRealm({endpoint:'http://localhost:9200',index:'realm',tenantId:'org_a',fetch:e.fetch});
  return {e,realm};
}

test('the same event uploaded by two installations becomes one session document',()=>{
  const event={id:'wire1:abc',kind:'tool_call',sequence:7,data:{type:'function_call',name:'exec',call_id:'call_1'}};
  const batch=installationId=>({schemaVersion:1,owner,harness:'codex',origin:'desktop',installationId,sessionId:'s1',events:[event],receivedAt:'2026-11-07T00:00:00.000Z'});
  const key=installationId=>`sessions/v1/${sessionScope(owner)}/codex/${digest(installationId)}/${digest('s1')}/${'0'.repeat(64)}.json.gz`;
  const ids=['install-a','install-b'].map(i=>batchDocuments({prefix:'sessions/v1',key:key(i),batch:batch(i),principal:owner})[0].id);
  assert.equal(ids[0],ids[1]);
  assert.equal(ids[0],sessionDocumentId({scope:sessionScope(owner),harness:'codex',sessionId:'s1',eventId:'wire1:abc',chunk:0}));
  // Authors, sessions and events still separate documents.
  assert.notEqual(ids[0],sessionDocumentId({scope:sessionScope(teammate),harness:'codex',sessionId:'s1',eventId:'wire1:abc',chunk:0}));
  assert.notEqual(ids[0],sessionDocumentId({scope:sessionScope(owner),harness:'codex',sessionId:'s2',eventId:'wire1:abc',chunk:0}));
  assert.notEqual(ids[0],sessionDocumentId({scope:sessionScope(owner),harness:'codex',sessionId:'s1',eventId:'wire1:abc',chunk:1}));
});

test('migration keeps one copy per captured record under its installation-independent ID',async()=>{
  const {e,realm}=setup();
  const legacy=doc(owner,{}),wire=doc(owner,{installationId:'install-b',eventId:'wire1:1',receivedAt:'2026-11-07T23:16:39.761Z'});
  const result=doc(owner,{kind:'tool_result',sequence:101,nativeId:'fco_1',toolNames:[],eventId:'legacy-2'});
  const resultCopy={...result,installationId:'install-b',eventId:'wire1:2'};
  const other=doc(owner,{sequence:200,nativeId:'fc_2',toolCallId:'call_2',eventId:'wire1:3'});
  // Same native position, different content: never merged.
  const rewritten=doc(owner,{sequence:300,nativeId:null,kind:'token_count',toolNames:[],toolCallId:null,text:'first',eventId:'e-a'});
  const revised={...rewritten,installationId:'install-b',text:'second',eventId:'e-b'};
  // A teammate's identical record stays theirs.
  const theirs=doc(teammate,{installationId:'install-c',eventId:'wire1:1'});
  for(const d of [legacy,wire,result,resultCopy,other,rewritten,revised,theirs])e.put(legacyId(d.userId===owner.userId?owner:teammate,d),d);
  const before=new Map(e.docs);

  const backups=[];
  const dry=await migrateSessionDocumentIds({realm,principal:owner,dryRun:true,pageSize:2,backup:async step=>backups.push(step)});
  assert.deepEqual(new Map(e.docs),before);assert.equal(backups.length,0);
  assert.deepEqual({scanned:dry.scanned,rewritten:dry.rewritten,duplicatesRemoved:dry.duplicatesRemoved,distinctContent:dry.distinctContent,complete:dry.complete},
    {scanned:8,rewritten:6,duplicatesRemoved:2,distinctContent:1,complete:true});

  const pages=[];
  const report=await migrateSessionDocumentIds({realm,principal:owner,pageSize:2,backup:async step=>backups.push(step),onPage:async r=>pages.push(r)});
  assert.equal(report.rewritten,6);assert.equal(report.duplicatesRemoved,2);
  const docs=e.flat();
  assert.equal(docs.length,6);
  const canonical=d=>sessionDocumentId({scope:sessionScope(d.userId===owner.userId?owner:teammate),harness:d.harness,sessionId:d.sessionId,eventId:d.eventId,chunk:d.chunk});
  for(const d of docs)assert.equal(d.id,canonical(d),'every document is at its new ID');
  // The current wire-format copy survives; the legacy copies are gone.
  assert.deepEqual(docs.filter(d=>d.userId==='user_a'&&d.sequence<=101).map(d=>d.eventId).sort(),['wire1:1','wire1:2']);
  assert.deepEqual(docs.filter(d=>d.sequence===300).map(d=>d.text).sort(),['first','second']);
  assert.equal(docs.filter(d=>d.userId==='user_b').length,1);
  // Every removed document and every new ID was handed to backup before the write.
  const removed=backups.flatMap(step=>step.removed),written=backups.flatMap(step=>step.written);
  assert.equal(removed.length,8);assert.equal(written.length,6);
  assert.ok(removed.every(item=>!e.docs.has('session:'+item.id)&&item.document.tenantId==='org_a'));
  assert.ok(removed.some(item=>item.document.eventId==='legacy-1'&&item.document.toolNames[0]==='exec'));
  assert.deepEqual(new Set(written),new Set(docs.map(d=>d.id)));
  // Resume points never fall inside a group of copies.
  assert.ok(pages.length>1&&pages.at(-1).complete);

  const again=await migrateSessionDocumentIds({realm,principal:owner,pageSize:3,backup:async()=>assert.fail('nothing left to change')});
  assert.deepEqual({rewritten:again.rewritten,duplicatesRemoved:again.duplicatesRemoved,unchanged:again.unchanged},{rewritten:0,duplicatesRemoved:0,unchanged:6});

  // Restoring the recorded steps returns the exact pre-migration documents.
  assert.deepEqual(await restoreSessionDocumentIds({realm,principal:owner,steps:backups}),{restored:8,removed:6});
  assert.deepEqual(new Map(e.docs),before);
  await assert.rejects(restoreSessionDocumentIds({realm,principal:{tenantId:'org_b'},steps:backups}),{status:403});
});

test('copies from older indexers merge despite reordered lines and different chunking',async()=>{
  const {e,realm}=setup();
  const fields={kind:'session_metadata',nativeId:null,toolNames:[],toolCallId:null};
  // Legacy indexer: other key order, split across two chunks.
  const a0=doc(owner,{...fields,text:'vscode\ncodex_work_desktop\n0.162',chunk:0}),a1=doc(owner,{...fields,text:'.0\n/Users/me/x',chunk:1});
  const b=doc(owner,{...fields,installationId:'install-b',eventId:'wire1:m',text:'0.162.0\n/Users/me/x\ncodex_work_desktop\nvscode'});
  // Same position but a genuinely different record stays.
  const c=doc(owner,{...fields,installationId:'install-b',eventId:'wire1:n',text:'0.163.0\n/Users/me/x\ncodex_work_desktop\nvscode'});
  for(const d of [a0,a1,b,c])e.put(legacyId(owner,d),d);
  const report=await migrateSessionDocumentIds({realm,principal:owner,pageSize:1,backup:async()=>{}});
  assert.deepEqual({rewritten:report.rewritten,duplicatesRemoved:report.duplicatesRemoved,distinctContent:report.distinctContent},{rewritten:2,duplicatesRemoved:2,distinctContent:1});
  assert.deepEqual(e.flat().map(d=>d.eventId).sort(),['wire1:m','wire1:n']);
});

test('an interrupted migration converges on the next run',async()=>{
  const {e,realm}=setup();
  const a=doc(owner,{}),b=doc(owner,{installationId:'install-b',eventId:'wire1:1'});
  e.put(legacyId(owner,a),a);e.put(legacyId(owner,b),b);
  // Simulate a crash after the surviving copy was written but before removals.
  e.put(sessionDocumentId({scope:sessionScope(owner),harness:'codex',sessionId:'s1',eventId:'wire1:1',chunk:0}),b);
  const report=await migrateSessionDocumentIds({realm,principal:owner,backup:async()=>{}});
  assert.equal(report.rewritten,0);assert.equal(report.duplicatesRemoved,2);
  assert.deepEqual(e.flat().map(d=>d.eventId),['wire1:1']);
});

test('migration and deletes are confined to the realm tenant',async()=>{
  const {realm}=setup();
  for(const principal of [{tenantId:'org_b'},{tenantId:'org_a',captureAccess:'write'}])
    await assert.rejects(migrateSessionDocumentIds({realm,principal,backup:async()=>{}}),{status:403});
  await assert.rejects(realm.collection('session').delete({tenantId:'org_b'},['x']),{status:403});
  await assert.rejects(realm.collection('session').delete({tenantId:'org_a'},['bad id/../x']),{status:400});
});
