import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {digest,sessionScope} from '../dist/src/sessions/ingest.mjs';
import {createSessionLibrary} from '../dist/src/sessions/library.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
import {realmResponse} from './realm-fixture.mjs';
export const owner={tenantId:'org_test',userId:'user_alice'}, peer={...owner,userId:'user_bob'}, prefix='sessions/test/v1';
export const batch=(overrides={})=>({schemaVersion:1,owner,harness:'codex',installationId:'laptop',sessionId:'native-session',origin:'desktop',
  events:[{id:'event',kind:'message',data:{role:'user',content:'erase-this-transcript'}}],attachments:[],...overrides});
const pause=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
export function fixture() {
  const store=memorySessionStore(), docs=new Map();let searchFailure=false;
  const match=(query,doc)=>{
    if(!query||typeof query!=='object')return true;
    if(query.term)return Object.entries(query.term).every(([key,value])=>key==='corpus'?value==='session':doc[key.replace(/^session\./,'')]===value);
    if(query.bool)return [...query.bool.filter??[],...query.bool.must??[]].every(q=>match(q,doc));
    return true;
  };
  const options={store,prefix,endpoint:'http://search.test',environment:'deletion',fetch:async(url,init)=>{
    const body=init.body?JSON.parse(init.body):{};
    const hits=[...docs].filter(([,doc])=>match(body.query,doc)).map(([id,doc])=>({_id:id,_score:1,_source:doc}));
    if(url.pathname.endsWith('_search'))return realmResponse('session',{hits:{total:{value:hits.length,relation:'eq'},hits:body.size===0?[]:hits},...(body.aggs?{aggregations:{sessions:{buckets:[]}}}:{})});
    if(url.pathname.endsWith('_delete_by_query')){
      if(searchFailure)return Response.json({failures:[{reason:'unavailable'}],deleted:0});
      for(const hit of hits)docs.delete(hit._id);
      return Response.json({failures:[],deleted:hits.length,version_conflicts:0});
    }
    if(url.pathname.endsWith('_refresh'))return Response.json({_shards:{failed:0}});
    throw Error('Unexpected request: '+url);
  }};
  const ingest=createSessionIngest({store,prefix}), library=()=>createSessionLibrary(options), search=createSessionSearch(options);
  const projection={identity:'deletion-test',ensureIndex:async()=>{},putDocuments:async items=>{for(const item of items)docs.set(item.id,item.document);},
    applySessionControl:async(p,key)=>{for(const [id,doc]of docs)if(doc.tenantId===p.tenantId&&doc.userId===p.userId&&doc.harness===key.harness&&doc.sessionId===key.sessionId)docs.delete(id);}};
  const pipeline=()=>createSessionPipeline({store,prefix,search:projection,resolvePrincipal:async({batch})=>batch.owner});
  const upload=async value=>{const receipt=await ingest.putBatch(value.owner,value);const key=`${prefix}/${sessionScope(value.owner)}/${value.harness}/${digest(value.installationId)}/${digest(value.sessionId)}/${receipt.batchId}.json.gz`;await pipeline().processObject({key});return {key,receipt};};
  return {store,docs,ingest,library,search,projection,pipeline,upload,options,setSearchFailure:value=>searchFailure=value};
}
