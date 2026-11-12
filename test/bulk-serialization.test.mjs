import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bulkItemLine} from '../dist/src/search/bulk.mjs';
import {realmDocument} from '../dist/src/search/realm.mjs';
import {writeScript} from '../dist/src/search/mutations.mjs';
const collection={encode:(id,document)=>realmDocument('session',id,document),id:id=>'session:'+id};
// Preserve the established NDJSON representation exactly: size preflight and
// transport must agree, including escaping, action metadata and policy fields.
function reference({id,document,script:legacyScript,policy}){
 const script=policy?writeScript(policy):legacyScript,doc=collection.encode(id,document);
 return JSON.stringify({[script?'update':'index']:{_id:collection.id(id),...(script?{retry_on_conflict:5}:{})}})+'\n'+JSON.stringify(script?{scripted_upsert:true,script:{lang:'painless',source:script,params:{doc}},upsert:{}}:doc)+'\n';
}
test('static policy frames preserve exact UTF-8 bulk bytes across every write mode',()=>{
 const modes=[...['session','connector','memory-head','session-projection'].map(policy=>({policy})),{policy:{name:'memory-projection-rollback',expectedProjectionId:'a'.repeat(64)}},{},{script:''},{script:'if (params.doc.text == "界🙂\\\\x") { ctx._source = params.doc; }\n// quote " and newline'}];
 const values=['',null,'quote " slash \\ newline\n tab\t control\u0000 lone\ud800 Unicode 界🙂','界🙂'.repeat(20000),{nested:[true,false,null,0,-0,1.2345,1e30,{text:'}\\"\n'}]}];
 for(const mode of modes)for(const value of values){
  const item={id:'event:one',document:{tenantId:'fixture',userId:'owner',harness:'codex',receivedAt:'2026-11-12T00:00:00Z',text:value,metadata:{missing:undefined,value}},...mode};
  const actual=bulkItemLine(item,collection),expected=reference(item);
  assert.deepEqual(Buffer.from(actual),Buffer.from(expected));
  assert.equal(actual.trimEnd().split('\n').length,2);
  for(const line of actual.trimEnd().split('\n'))JSON.parse(line);
 }
});
test('uncached rollback and legacy policies never reuse another script frame',()=>{
 const document={tenantId:'fixture',userId:'owner',text:'evidence'};
 for(let i=0;i<20;i++)for(const mode of [{script:'ctx._source.sequence = '+i+';'}, {policy:{name:'memory-projection-rollback',expectedProjectionId:i.toString(16).padStart(64,'0')}}]){
  const item={id:'event-'+i,document,...mode};assert.equal(bulkItemLine(item,collection),reference(item));
 }
 assert.throws(()=>bulkItemLine({id:'event',document,policy:'unknown'},collection),/Unsupported index write policy/);
});
