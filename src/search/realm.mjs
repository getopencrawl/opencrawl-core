import {createHash} from 'node:crypto';
import {signRequest} from '../sessions/s3-store.mjs';
import {realmMapping} from './mapping.mjs';
export {realmMapping};
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message,status=503) => Object.assign(new Error(message),{status,permanent:status===403});
const corpora = new Set(['connector','session','board']);
export function realmIndex(environment,tenantId,generation='v1') {
  if (!/^[a-z][a-z0-9-]{0,24}$/.test(environment) || !/^v[1-9][0-9]*$/.test(generation) || typeof tenantId!=='string' || !tenantId) throw fail('Invalid realm scope',403);
  return `opencrawl-${environment}-realm-${hash(tenantId)}-${generation}`;
}
export function realmField(corpus,field) {
  if(!corpora.has(corpus)) throw fail('Invalid corpus',400);
  return ['tenantId','text','title','sourceKey'].includes(field)?field:corpus+'.'+field;
}
export function realmDocument(corpus,id,document) {
  if(!corpora.has(corpus)||typeof id!=='string'||!/^[A-Za-z0-9_:-]{1,256}$/.test(id)||typeof document?.tenantId!=='string'||!document.tenantId) throw fail('Document realm scope required',403);
  const {tenantId,text,title,sourceKey,...metadata}=document;
  const raw=document.timestamp;
  let timestamp= typeof raw==='number'?raw:typeof raw==='string'&&/^\d{10}(\.\d+)?$/.test(raw)?Number(raw)*1000:Date.parse(raw);
  if(!Number.isFinite(timestamp)) timestamp=Date.parse(document.receivedAt)||document.extractedAt;
  const author=document.author??document.authorId??document.userId;
  const source=corpus==='connector'?document.provider:corpus==='session'?document.harness:'board';
  return {schema:1,tenantId,corpus,id,source,kind:document.kind||'message',
    ...(Number.isFinite(timestamp)?{timestamp:new Date(timestamp).toISOString()}:{}),
    ...(author?{author}:{}),
    ...(text!==undefined?{text}:{}),...(title!==undefined?{title}:{}),...(sourceKey!==undefined?{sourceKey}:{}),[corpus]:metadata};
}
function compatible(actual,expected) {
  if(expected.type && (actual?.type||(actual?.properties?'object':undefined))!==expected.type) return false;
  if(expected.dynamic && actual?.dynamic!==expected.dynamic) return false;
  for(const option of ['index','doc_values','ignore_malformed','analyzer']) if(expected[option]!==undefined && actual?.[option]!==expected[option]) return false;
  for(const key of ['properties','fields']) for(const [name,value] of Object.entries(expected[key]||{})) if(!compatible(actual?.[key]?.[name],value))return false;
  return true;
}
/** One tenant-bound index, mapping and transport for every searchable corpus. */
export function createRealm({endpoint,index,tenantId,environment='selfhost',generation='v1',username,password,credentials,region='us-east-1',replicas=0,fetch:send=globalThis.fetch}) {
  if(typeof tenantId!=='string'||!tenantId)throw fail('Realm tenant required',403);
  index ||= realmIndex(environment,tenantId,generation);
  const base=new URL(endpoint);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!/^[a-z][a-z0-9_-]{0,150}$/.test(index))throw fail('Invalid realm endpoint or index',400);
  if(Boolean(username)!==Boolean(password)||!Number.isInteger(replicas)||replicas<0||replicas>2)throw fail('Invalid realm configuration',400);
  const scope=principal=>{if(principal?.tenantId!==tenantId)throw fail('Realm scope denied',403);};
  const request=createIndexTransport({endpoint,index,username,password,credentials,region,fetch:send});
  let ready;
  async function ensureIndex(){
    ready ||= (async()=>{
      try{await request('',{settings:{number_of_shards:1,number_of_replicas:replicas},mappings:{...realmMapping,_meta:{schema:1,tenantId}}},'PUT');}
      catch(e){if(e.status!==400||e.type!=='resource_already_exists_exception')throw e;}
      const mapping=(await request('/_mapping',undefined,'GET'))?.[index]?.mappings;
      if(mapping?._meta?.tenantId!==tenantId||mapping?._meta?.schema!==1||!compatible(mapping,realmMapping))throw fail('Realm mapping or tenant mismatch; migrate to a new generation');
    })().catch(e=>{ready=undefined;throw e;});
    return ready;
  }
  const checkSearch=result=>{
    if(result?.timed_out!==false||result?._shards?.failed!==0||!Array.isArray(result?.hits?.hits))throw fail('Realm search incomplete');
    return result;
  };
  return {index,tenantId,identity:base.origin+base.pathname+'/'+index,ensureIndex,scope,
    collection(corpus){
      if(!corpora.has(corpus))throw fail('Invalid corpus',400);
      const encodedId=id=>corpus+':'+id;
      const encode=(id,document)=>{if(document.tenantId!==tenantId)throw fail('Document realm scope mismatch',403);return realmDocument(corpus,id,document);};
      function decode(hit){
        if(hit.found===false){if(!hit._id?.startsWith(corpus+':'))throw fail('Realm identity mismatch');return {...hit,_id:hit._id.slice(corpus.length+1)};}
        const d=hit._source;
        if(d?.schema!==1||d.tenantId!==tenantId||d.corpus!==corpus||typeof d.id!=='string'||hit._id!==encodedId(d.id)||!d[corpus])throw fail('Realm response ownership scope mismatch');
        return {...hit,_id:d.id,_source:{...d[corpus],tenantId,...Object.fromEntries(['text','title','sourceKey'].filter(k=>d[k]!==undefined).map(k=>[k,d[k]]))}};
      }
      return {field:field=>realmField(corpus,field),encode,id:encodedId,
        async search(principal,body){
          scope(principal);
          const query={bool:{filter:[{term:{tenantId}},{term:{corpus}}],must:[body.query||{match_all:{}}]}};
          // Scope/identity fields are always fetched, including for ID-only board snapshots.
          const source=Array.isArray(body._source)?[...new Set(['schema','tenantId','corpus','id',...body._source.map(f=>realmField(corpus,f))])]:body._source;
          const scopedBody={...body,query,...(source?{_source:source}:{})};
          let result;
          try{result=checkSearch(await request('/_search',scopedBody));}
          catch(e){if(e.status!==404)throw e;ready=undefined;await ensureIndex();result=checkSearch(await request('/_search',scopedBody));}
          result.hits.hits=result.hits.hits.map(decode);return result;
        },
        async mget(principal,ids){scope(principal);const result=await request('/_mget',{ids:ids.map(encodedId)});if(!Array.isArray(result.docs)||result.docs.length!==ids.length)throw fail('Incomplete realm lookup');const docs=result.docs.map(decode);if(docs.some(d=>!ids.includes(d._id))||new Set(docs.map(d=>d._id)).size!==ids.length)throw fail('Realm lookup identity mismatch');return {...result,docs};},
        async bulk(principal,items,{refresh=false}={}){
          scope(principal);if(!items.length)return {items:[]};
          const body=items.map(({id,document,script})=>{
            const doc=encode(id,document);
            return JSON.stringify({[script?'update':'index']:{_id:encodedId(id),...(script?{retry_on_conflict:5}:{})}})+'\n'+JSON.stringify(script?{scripted_upsert:true,script:{lang:'painless',source:script,params:{doc}},upsert:{}}:doc)+'\n';
          }).join('');
          if(Buffer.byteLength(body)>4*1024*1024)throw fail('Realm bulk exceeds limit',400);
          const result=await request('/_bulk'+(refresh?'?refresh=wait_for':''),body,'POST','application/x-ndjson');
          if(result.errors||!Array.isArray(result.items)||result.items.length!==items.length||result.items.some(item=>{const op=item.index||item.update;return !op||op.status<200||op.status>=300;}))throw fail('Realm bulk contained failed or missing items');
          return result;
        },
        async update(principal,id,{script,upsert}){scope(principal);return request('/_update/'+encodedId(id),{script,upsert:encode(id,upsert)});},
      };
    },
    async refresh(principal){scope(principal);return request('/_refresh');},
  };
}

/** Runtime routing uses a trusted principal; requests never supply an index name. */
export function createRealmResolver(options) {
  const realms=new Map();
  function resolve(principal){
    const tenantId=principal?.tenantId;
    if(typeof tenantId!=='string'||!tenantId||(options.tenantId&&options.tenantId!==tenantId))throw fail('Realm scope denied',403);
    let realm=realms.get(tenantId);
    if(!realm){realm=createRealm({...options,tenantId});if(realms.size>=128)realms.delete(realms.keys().next().value);realms.set(tenantId,realm);}
    return realm;
  }
  resolve.identity=JSON.stringify([options.endpoint,options.environment||'selfhost',options.generation||'v1',options.index||'organization-realms']);
  return resolve;
}

export function createIndexTransport({endpoint,index,username,password,credentials,region='us-east-1',fetch:send=globalThis.fetch}) {
  const base=new URL(endpoint);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!/^[a-z][a-z0-9_-]{0,150}$/.test(index))throw fail('Invalid index transport',400);
  return async function request(path,body,method='POST',contentType='application/json') {
    const url=new URL(base.href.replace(/\/$/,'')+'/'+index+path);
    body=body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body);
    let headers={'content-type':contentType};
    if(username)headers.authorization='Basic '+Buffer.from(username+':'+password).toString('base64');
    if(credentials){const c=await credentials();if(c.sessionToken)headers['x-amz-security-token']=c.sessionToken;headers=signRequest({method,url,body,headers,region,service:'es',...c});}
    const response=await send(url,{method,body,headers,signal:AbortSignal.timeout(30000),redirect:'error'});
    let data;try{data=await response.json();}catch{throw fail('Invalid realm response');}
    if(!response.ok)throw Object.assign(fail('Realm request failed ('+response.status+')',response.status),{httpStatus:response.status,type:data?.error?.type});
    return data;
  };
}
