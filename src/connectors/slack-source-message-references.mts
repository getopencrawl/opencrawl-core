import type {SlackCaptureOptions, SlackQuery, SlackApiData} from './types.mjs';
import type {MessageReference, ReferenceRun, ReferenceCheckpoint, CaptureStepResult} from './capture-types.mjs';
import {gzipSync} from 'node:zlib';
import {validateBinding,digest,invalidRecord} from './scope.mjs';

const timestamp=(value: unknown): value is string=>typeof value==='string'&&/^\d{1,16}\.\d{1,6}$/.test(value);
const micros=(value: string)=>{const [seconds,fraction]=value.split('.');return BigInt(seconds)*1000000n+BigInt(fraction.padEnd(6,'0'));};
function referencesInput(references: MessageReference[]) {
 if(!Array.isArray(references)||!references.length||references.length>1000)invalidRecord('Expected 1 to 1000 message references');
 const seen=new Set();
 return references.map(ref=>{
  if(!ref||typeof ref.channelId!=='string'||!/^C[A-Z0-9]{1,100}$/.test(ref.channelId)||!timestamp(ref.ts)||ref.threadTs!==undefined&&!timestamp(ref.threadTs))invalidRecord('Invalid public message reference');
  const value={channelId:ref.channelId,ts:ref.ts,threadTs:ref.threadTs||ref.ts};
  if(micros(value.threadTs)>micros(value.ts))invalidRecord('Reply precedes parent');
  const key=value.channelId+':'+micros(value.ts);if(seen.has(key))invalidRecord('Duplicate message reference');seen.add(key);return value;
 });
}

/** Refresh explicit native identities without pretending to enumerate a channel.
 * Operators serialize this with other history/replies captures for the workspace. */
export function createSlackMessageReferenceCapture({binding,store,request,checkActive=async()=>{},now=Date.now}: SlackCaptureOptions) {
 validateBinding(binding);if(binding.provider!=='slack')invalidRecord('Slack source binding required');
 const active=async()=>{validateBinding(binding);await checkActive(binding);};
 async function put(key: string,bytes: Uint8Array,type: string){await active();await store.put(key,bytes,type);}
 return {async step({runId,references}: ReferenceRun): Promise<CaptureStepResult> {
  if(!/^[A-Za-z0-9_-]{1,150}$/.test(runId||''))invalidRecord('Invalid reference capture run');
  const refs=referencesInput(references),inputHash=digest(refs);
  await active();const prefix=binding.rawPrefix+'capture/message-references-v1/'+runId+'/',stateKey=prefix+'state.json';
  const bytes=await store.get(stateKey,{maxBytes:1024*1024});
  const state: ReferenceCheckpoint=bytes?JSON.parse(bytes.toString()) as ReferenceCheckpoint:{version:1,scope:digest(binding),runId,inputHash,position:0,nextDue:{},pages:0,emitted:0,errors:[]};
  if(state.version!==1||state.scope!==digest(binding)||state.runId!==runId||state.inputHash!==inputHash||!Number.isSafeInteger(state.position)||state.position<0||state.position>refs.length)invalidRecord('Reference capture checkpoint scope mismatch');
  const save=()=>put(stateKey,Buffer.from(JSON.stringify(state)),'application/json');
  const fail=async(method: string,code: string)=>{state.errors.push({position:state.position,method,code});state.position++;await save();return {done:false,waitMs:0};};
  if(state.position===refs.length)return {done:true,references:refs.length,pages:state.pages,emitted:state.emitted,failed:state.errors.length};
  const ref=refs[state.position],reply=micros(ref.threadTs)!==micros(ref.ts),method=reply?'conversations.replies':'conversations.history';
  const due=Math.max(state.nextDue[method]||0,state.nextDue['conversations.info']||0);
  if(due>now())return {done:false,waitMs:due-now()};
  async function read(api: string,query: SlackQuery): Promise<{retry: true; error?: never; data?: never; at?: never} | {error: string; retry?: never; data?: never; at?: never} | {data: SlackApiData; at: number; retry?: never; error?: never}> {
   // Persist the rate reservation before the request, including transport failures.
   state.nextDue[api]=now()+(api==='conversations.info'?3500:65000);await save();await active();
   const response=await request(api,query),at=now(),data=response?.data;
   if(response?.status===429||data?.error==='ratelimited') {
    const seconds=Number(Object.entries(response.headers||{}).find(([k])=>k.toLowerCase()==='retry-after')?.[1]||60);
    state.nextDue[api]=at+Math.max(65000,Number.isFinite(seconds)?seconds*1000:65000);await save();return {retry:true};
   }
   if(response?.status>=500)throw new Error('Transient Slack message reference failure');
   if(response?.status!==200||data?.ok!==true)return {error:typeof data?.error==='string'?data.error.slice(0,100):'invalid_response'};
   const page=Buffer.from(JSON.stringify({method:api,query,observedAt:at,data}));
   await put(prefix+'pages/'+digest(page.toString())+'.json',page,'application/json');state.pages++;
   return {data,at};
  }
  const info=await read('conversations.info',{channel:ref.channelId});
  if(info.retry)return {done:false,waitMs:0};
  if(info.error)return fail('conversations.info',info.error);
  const channel=info.data!.channel;
  if(channel?.id!==ref.channelId||channel.is_private!==false||channel.is_im||channel.is_mpim)invalidRecord('Message reference is not an authorized public channel');
  const query={channel:ref.channelId,...(reply?{ts:ref.threadTs}:{}),oldest:ref.ts,latest:ref.ts,inclusive:true,limit:15,include_all_metadata:true};
  const source=await read(method,query);
  if(source.retry)return {done:false,waitMs:0};
  if(source.error)return fail(method,source.error);
  if(!Array.isArray(source.data!.messages)||source.data!.has_more||source.data!.response_metadata?.next_cursor)invalidRecord('Incomplete exact-message response');
  const matches=source.data!.messages.filter(message=>message.ts===ref.ts);
  if(matches.length===0)return fail(method,'message_not_found');
  if(matches.length!==1)invalidRecord('Ambiguous exact-message response');
  const message=matches[0];
  if((message.channel_id&&message.channel_id!==ref.channelId)||(message.channel&&message.channel!==ref.channelId)||(reply?message.thread_ts!==ref.threadTs:message.thread_ts&&message.thread_ts!==ref.ts))invalidRecord('Message reference identity mismatch');
  const raw=Buffer.from(JSON.stringify({_airbyte_extracted_at:source.at,_airbyte_data:{...message,channel_id:ref.channelId}})+'\n');
  await put(binding.rawPrefix+`stream=canonical_messages/date=${new Date(source.at!).toISOString().slice(0,10)}/sync=${runId}/${digest(raw.toString())}.jsonl.gz`,gzipSync(raw),'application/gzip');
  state.emitted++;state.position++;await save();return {done:false,waitMs:0,pages:state.pages,emitted:state.emitted};
 }};
}
