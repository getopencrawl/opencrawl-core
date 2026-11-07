import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {validateBinding,digest,invalidRecord} from './scope.mjs';
import {SourcePaginationError,sourcePaginationProgress,advanceSourcePagination,sourcePaginationCheckpoint} from './workflow.mjs';
export {seedSlackSourceCatalog} from './slack-source-catalog.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=value=>typeof value==='string'&&/^[A-Z][A-Z0-9]{1,100}$/.test(value);
const timestamp=value=>typeof value==='string'&&/^\d{1,16}\.\d{1,6}$/.test(value);
function pagination(operation) {
 try{return operation();}catch(error){if(error instanceof SourcePaginationError)invalidRecord('Invalid Slack message cursor progression');throw error;}
}
/** Canonical history/replies capture has no search-result or backfill-date filter.
 * Method-specific durable pacing respects Slack's restrictive history tier. */
export function createSlackMessageCapture({binding,store,request,checkActive=async()=>{},now=Date.now}) {
 validateBinding(binding);if(binding.provider!=='slack')invalidRecord('Slack source binding required');
 const active=async()=>{validateBinding(binding);await checkActive(binding);};
 async function put(key,bytes,type){await active();await store.put(key,bytes,type);}
 return {async step({runId,cutoff}) {
  if(!/^[A-Za-z0-9_-]{1,150}$/.test(runId||'')||!Number.isSafeInteger(cutoff)||cutoff<0)invalidRecord('Invalid message capture run');
  await active();const prefix=binding.rawPrefix+'capture/messages-v1/'+runId+'/',stateKey=prefix+'state.json';
  const raw=await store.get(stateKey,{maxBytes:16*1024*1024});
  const state=raw?JSON.parse(raw):{version:1,scope:digest(binding),runId,cutoff,channels:{},threads:{},cursor:'',listed:false,nextDue:{},pages:0,emitted:0,errors:[]};
  if(state.version!==1||state.scope!==digest(binding)||state.runId!==runId||state.cutoff!==cutoff)invalidRecord('Message capture checkpoint scope mismatch');
  const catalogKey=binding.rawPrefix+'capture/messages-v1/catalog.json';
  const catalogBytes=await store.get(catalogKey,{maxBytes:16*1024*1024});
  const catalog=catalogBytes?JSON.parse(catalogBytes):{scope:digest(binding),channels:[]};
  if(catalog.scope!==digest(binding)||!Array.isArray(catalog.channels)||catalog.channels.some(channel=>!id(channel)))invalidRecord('Message channel catalog scope mismatch');
  // Catalog publication precedes the final checkpoint. Reconcile it even on
  // same-run retries, whose saved checkpoint may predate a public raw record.
  state.priorChannels=[...new Set([...(state.priorChannels||[]),...catalog.channels])];
  const saveCatalog=async()=>{
   const bytes=Buffer.from(JSON.stringify({scope:digest(binding),channels:[...new Set([...state.priorChannels,...Object.keys(state.channels)])]}));
   if(bytes.length>16*1024*1024)invalidRecord('Message channel catalog exceeds limit');
   await put(catalogKey,bytes,'application/json');
  };
  const save=async()=>{const body=Buffer.from(JSON.stringify(state));if(body.length>16*1024*1024)invalidRecord('Message capture checkpoint exceeds limit');await put(stateKey,body,'application/json');};
  const emit=async(stream,data,at)=>{
   if(!data.length)return;
   const bytes=Buffer.from(data.map(d=>JSON.stringify({_airbyte_extracted_at:at,_airbyte_data:d})).join('\n')+'\n');
   await put(binding.rawPrefix+`stream=${stream}/date=${new Date(at).toISOString().slice(0,10)}/sync=${runId}/${hash(bytes)}.jsonl.gz`,gzipSync(bytes),'application/gzip');state.emitted+=data.length;
  };
  let method,query,target;const pending=[];
  if(!state.listed)pending.push({method:'conversations.list',query:{types:'public_channel',exclude_archived:false,limit:200,cursor:state.cursor||undefined}});
  else {
   const channel=Object.values(state.channels).find(c=>!c.done&&!c.error);
   const thread=Object.values(state.threads).find(t=>!t.done&&!t.error);
   if(channel)pending.push({method:'conversations.history',target:channel,query:{channel:channel.id,latest:String(cutoff/1000),limit:15,include_all_metadata:true,cursor:channel.cursor||undefined}});
   if(thread)pending.push({method:'conversations.replies',target:thread,query:{channel:thread.channel,ts:thread.ts,latest:String(cutoff/1000),limit:15,include_all_metadata:true,cursor:thread.cursor||undefined}});
  }
  if(!pending.length)return {done:true,channels:Object.keys(state.channels).length,threads:Object.keys(state.threads).length,pages:state.pages,emitted:state.emitted,failed:state.errors.length};
  const task=pending.find(p=>(state.nextDue[p.method]||0)<=now());
  if(!task)return {done:false,waitMs:Math.max(1,Math.min(...pending.map(p=>state.nextDue[p.method]))-now())};
  ({method,query,target}=task);
  // Root enumeration, each channel, and each thread retain separate progress;
  // the enclosing checkpoint binds their run, cutoff window, and trusted scope.
  const cursorOwner=target||state;
  const progress=pagination(()=>sourcePaginationProgress(cursorOwner.cursor===''?null:cursorOwner.cursor,cursorOwner.paginationProgress));
  // Persist the request reservation even when transport or response processing
  // fails; retries retain the same cursor but must respect the method window.
  state.nextDue[method]=now()+(method==='conversations.list'?3500:65000);await save();await active();
  const response=await request(method,query),data=response?.data,at=now();state.nextDue[method]=at+(method==='conversations.list'?3500:65000);
  if(response?.status===429||data?.error==='ratelimited') {
   const seconds=Number(Object.entries(response.headers||{}).find(([k])=>k.toLowerCase()==='retry-after')?.[1]||60);
   state.nextDue[method]=at+Math.max(65000,Number.isFinite(seconds)?seconds*1000:65000);await save();return {done:false,waitMs:0};
  }
  if(response?.status>=500)throw new Error('Transient Slack history failure');
  if(response?.status!==200||data?.ok!==true) {
   if(!target)throw new Error('Public channel enumeration failed');
   const code=typeof data?.error==='string'?data.error.slice(0,100):'invalid_response';target.error=code;state.errors.push({method,channel:query.channel,thread:query.ts,code});await save();return {done:false,waitMs:0};
  }
  const cursor=data.response_metadata?.next_cursor??'';
  if(typeof cursor!=='string'||cursor.length>10000||cursor&&cursor===query.cursor||data.has_more&&!cursor)invalidRecord('Incomplete or repeated Slack history cursor');
  const nextProgress=pagination(()=>advanceSourcePagination(progress,{keys:[],cursor:cursor||null}));
  const page=Buffer.from(JSON.stringify({method,query,observedAt:at,data}));await put(prefix+'pages/'+hash(page)+'.json',page,'application/json');
  if(method==='conversations.list') {
   if(!Array.isArray(data.channels))invalidRecord('Missing public channels');
   for(const c of data.channels){if(!id(c.id)||c.is_private!==false||c.is_im||c.is_mpim)invalidRecord('Invalid public channel');state.channels[c.id]||={id:c.id,cursor:'',done:false};}
   // Remember every published public channel before the raw write. Only a
   // completed enumeration can revoke channels missing from its current scope.
   await saveCatalog();
   await emit('channels',data.channels,at);state.cursor=cursor;state.paginationProgress=sourcePaginationCheckpoint(nextProgress);state.listed=!cursor;
   if(state.listed)await emit('channels',state.priorChannels.filter(channel=>!state.channels[channel]).map(id=>({id,is_private:true})),at);
  } else {
   if(!state.channels[query.channel]||!Array.isArray(data.messages))invalidRecord('History response outside enumerated public scope');
   for(const m of data.messages) {
    if(!timestamp(m.ts)||m.thread_ts&&!timestamp(m.thread_ts))invalidRecord('Invalid Slack message timestamp');
    if(m.reply_count>0){const ts=m.thread_ts||m.ts;state.threads[query.channel+':'+ts]||={channel:query.channel,ts,cursor:'',done:false};}
   }
   await emit('canonical_messages',data.messages.map(m=>({...m,channel_id:query.channel})),at);
   target.cursor=cursor;target.paginationProgress=sourcePaginationCheckpoint(nextProgress);target.done=!cursor;
  }
  state.pages++;await save();return {done:false,waitMs:0,pages:state.pages,emitted:state.emitted};
 }};
}
