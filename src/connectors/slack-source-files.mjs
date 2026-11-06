import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {validateBinding,digest,invalidRecord} from './scope.mjs';
const MAX=20*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const validId=value=>typeof value==='string'&&/^[A-Z][A-Z0-9]{1,100}$/.test(value);
function nextCursor(data,current) {
 const next=data.response_metadata?.next_cursor||'';
 if(typeof next!=='string'||next.length>10000||next&&next===current)invalidRecord('Invalid or repeated source cursor');
 return next;
}
function apiText(file,comments) {
 const parts=[];
 for(const name of ['title','name','preview','preview_plain_text','plain_text','alt_txt','description']) {
  if(typeof file[name]==='string'&&file[name])parts.push({path:'file.'+name,text:file[name]});
 }
 if(typeof file.initial_comment?.comment==='string')parts.push({path:'file.initial_comment',text:file.initial_comment.comment});
 for(const [id,text] of Object.entries(comments))parts.push({path:'comments.'+id,text});
 return parts;
}
/** The source adapter supplies provider-neutral, authenticated request/download
 * operations. State and raw text stay in the scoped store, never workflow history.
 * Exactly one capture workflow may advance a connection's run at a time. */
export function createSlackFileCapture({binding,store,request,download,checkActive=async()=>{},now=Date.now}) {
 validateBinding(binding);if(binding.provider!=='slack')invalidRecord('Slack source binding required');
 async function active(){validateBinding(binding);await checkActive(binding);}
 async function put(key,body,type){await active();await store.put(key,body,type);}
 return {async step({runId,cutoff}) {
  if(!/^[A-Za-z0-9_-]{1,150}$/.test(runId||'')||!Number.isSafeInteger(cutoff)||cutoff<0)invalidRecord('Invalid source run');
  await active();
  const stateKey=binding.rawPrefix+'capture/files-v1/'+runId+'/state.json';
  const raw=await store.get(stateKey,{maxBytes:16*1024*1024});
  const catalogKey=binding.rawPrefix+'capture/files-v1/catalog.json';
  const catalogBytes=raw?null:await store.get(catalogKey,{maxBytes:16*1024*1024});
  const catalog=catalogBytes?JSON.parse(catalogBytes):{scope:digest(binding),channels:[],files:{}};
  if(catalog.scope!==digest(binding))invalidRecord('Capture catalog scope mismatch');
  const state=raw?JSON.parse(raw):{version:1,runId,cutoff,scope:digest(binding),channels:{},priorChannels:catalog.channels,files:Object.fromEntries(Object.entries(catalog.files).map(([id,channels])=>[id,{id,channels,comments:{},cursor:'',done:false}])),cursor:'',listed:false,nextDue:0,pages:0,emitted:0,errors:[]};
  if(state.version!==1||state.runId!==runId||state.cutoff!==cutoff||state.scope!==digest(binding))invalidRecord('Capture checkpoint scope mismatch');
  const saveCatalog=async()=>{const catalog={scope:digest(binding),channels:[...new Set([...state.priorChannels,...Object.keys(state.channels)])],files:Object.fromEntries(Object.values(state.files).map(f=>[f.id,f.channels]))};await put(catalogKey,Buffer.from(JSON.stringify(catalog)),'application/json');};
  const save=async()=>{await saveCatalog();const body=Buffer.from(JSON.stringify(state));if(body.length>16*1024*1024)invalidRecord('Capture checkpoint exceeds limit');await put(stateKey,body,'application/json');};
  const emit=async(stream,records,observedAt)=>{
   if(!records.length)return;
   const body=Buffer.from(records.map(data=>JSON.stringify({_airbyte_extracted_at:observedAt,_airbyte_data:data})).join('\n')+'\n');
   const key=binding.rawPrefix+`stream=${stream}/date=${new Date(observedAt).toISOString().slice(0,10)}/sync=${runId}/${hash(body)}.jsonl.gz`;
   await put(key,gzipSync(body),'application/gzip');state.emitted+=records.length;
  };
  if(state.nextDue>now())return {done:false,waitMs:state.nextDue-now()};
  let method,query,target;
  if(!state.listed){method='conversations.list';query={types:'public_channel',exclude_archived:false,limit:200,cursor:state.cursor||undefined};}
  else if(target=Object.values(state.channels).find(c=>!c.done&&!c.error)){method='files.list';query={channel:target.id,count:100,page:target.page||1,ts_to:Math.floor(cutoff/1000),show_files_hidden_by_limit:true};}
  else if(target=Object.values(state.files).find(f=>!f.done&&!f.error)){method='files.info';query={file:target.id,limit:100,cursor:target.cursor||undefined};}
  else return {done:true,channels:Object.keys(state.channels).length,files:Object.keys(state.files).length,emitted:state.emitted,failed:state.errors.length};
  const response=await request(method,query);const data=response?.data;const observedAt=now();
  state.nextDue=observedAt+3500;
  if(response?.status===429||data?.error==='ratelimited') {
   const delay=Number(Object.entries(response.headers||{}).find(([k])=>k.toLowerCase()==='retry-after')?.[1]||60);
   state.nextDue=observedAt+Math.max(65000,Number.isFinite(delay)?delay*1000:65000);await save();return {done:false,waitMs:state.nextDue-now()};
  }
  if(response?.status>=500)throw new Error('Transient Slack source failure');
  if(response?.status!==200||data?.ok!==true) {
   const code=typeof data?.error==='string'?data.error.slice(0,100):'invalid_response';
   if(!target)throw new Error('Slack channel enumeration failed: '+code);
   if(method==='files.info'&&['file_not_found','access_denied','not_in_channel'].includes(code)){await emit('file_documents',target.channels.map(channel_id=>({format_version:1,id:target.id,channel_id,available:false})),observedAt);}
   target.error=code;state.errors.push({method,id:target.id,code});await save();return {done:false,waitMs:3500};
  }
  // Preserve the exact API envelope separately from searchable derived records.
  const sourcePage=Buffer.from(JSON.stringify({method,query,observedAt,data}));
  await put(binding.rawPrefix+'capture/files-v1/'+runId+'/pages/'+hash(sourcePage)+'.json',sourcePage,'application/json');state.pages++;
  if(method==='conversations.list') {
   if(!Array.isArray(data.channels))invalidRecord('Missing public channels');
   for(const channel of data.channels){if(!validId(channel.id)||channel.is_private!==false||channel.is_im||channel.is_mpim)invalidRecord('Invalid public channel');state.channels[channel.id]||={id:channel.id,page:1,done:false};}
   await emit('channels',data.channels,observedAt);state.cursor=nextCursor(data,state.cursor);state.listed=!state.cursor;
   if(state.listed){const missing=state.priorChannels.filter(id=>!state.channels[id]);await emit('channels',missing.map(id=>({id,is_private:true})),observedAt);}
  } else if(method==='files.list') {
   if(!Array.isArray(data.files)||!Number.isInteger(data.paging?.pages)||data.paging.pages<0||data.paging.page!==query.page)invalidRecord('Invalid file listing pagination');
   for(const file of data.files){if(!validId(file.id))invalidRecord('Invalid file identity');const saved=state.files[file.id]||={id:file.id,channels:[],comments:{},cursor:'',done:false};if(!saved.channels.includes(target.id))saved.channels.push(target.id);}
   target.done=query.page>=data.paging.pages;target.page=query.page+1;
  } else {
   const file=data.file;if(!file||file.id!==target.id)invalidRecord('File identity mismatch');
   const shared=[...new Set([...(file.channels||[]),...Object.keys(file.shares?.public||{})])].filter(id=>state.channels[id]);
   if(!shared.length) {
    await emit('file_documents',target.channels.map(channel_id=>({format_version:1,id:target.id,channel_id,available:false})),observedAt);target.done=true;
   } else {
    if(data.comments!==undefined&&!Array.isArray(data.comments))invalidRecord('Invalid file comments');
    for(const comment of data.comments||[]){if(typeof comment.id!=='string'||typeof comment.comment!=='string')invalidRecord('Invalid file comment');target.comments[comment.id]=comment.comment;}
    target.cursor=nextCursor(data,target.cursor);
    if(!target.cursor) {
     if(Number.isInteger(data.paging?.pages)&&data.paging.pages>1&&!data.response_metadata)invalidRecord('File comments require cursor pagination');
     let content={};const mediaType=(file.mimetype||'application/octet-stream').split(';')[0].toLowerCase();
     if(!mediaType.startsWith('image/')){
      // Provider adapters must allowlist URLs and return original bytes, not previews.
      const body=await download(file);
      if(!(body?.bytes instanceof Uint8Array)||body.bytes.length>MAX||!body.bytes.length||typeof body.mediaType!=='string')invalidRecord('Invalid downloaded file');
      const sha=hash(body.bytes),contentKey=binding.rawPrefix+'files/sha256/'+sha+'.bin';
      await put(contentKey,body.bytes,body.mediaType);
      content={content_key:contentKey,content_sha256:sha,content_bytes:body.bytes.length,media_type:body.mediaType};
     }
     await saveCatalog();
     const record={format_version:1,id:file.id,available:true,title:file.title,name:file.name,user:file.user,media_type:mediaType,api_text:apiText(file,target.comments),...content};
     await emit('file_documents',shared.map(channel_id=>({...record,channel_id})),observedAt);
     // Explicitly revoke previously observed public shares removed from current metadata.
     const removed=target.channels.filter(id=>!shared.includes(id));
     await emit('file_documents',removed.map(channel_id=>({format_version:1,id:file.id,channel_id,available:false})),observedAt);
     target.done=true;target.comments={};
    }
   }
  }
  await save();return {done:false,waitMs:Math.max(0,state.nextDue-now()),pages:state.pages,emitted:state.emitted};
 }};
}
