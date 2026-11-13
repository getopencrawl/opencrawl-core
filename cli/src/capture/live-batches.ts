import {existsSync,mkdirSync,readdirSync,readFileSync,unlinkSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {atomicFile,atomicJson,syncDirectory} from '../session.ts';
import {retryWindowsSharing} from '../filesystem.ts';
import {hash} from './parse.ts';

const names=(directory:string)=>existsSync(directory)?readdirSync(directory).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)):[];
const remove=(path:string)=>{try{retryWindowsSharing(()=>unlinkSync(path));}catch(error:any){if(error.code!=='ENOENT')throw error;}};
/** Only freshly recorded live batches are eligible. Existing queues from older
 * CLIs and any batch that may have reached a receiver keep their exact bytes. */
export function enqueueLiveBatch(directory:string,name:string,serialized:string,live:boolean) {
 const target=join(directory,'queue',name);
 if(existsSync(target))return;
 if(live){
  mkdirSync(join(directory,'live'),{recursive:true});
  atomicFile(join(directory,'live',name),'');
 }
 atomicFile(target,serialized+'\n');
}
export const isPendingLive=(directory:string,name:string)=>existsSync(join(directory,'live',name));
export function pendingLiveSince(directory:string) {
 let oldest=Infinity;
 for(const name of names(join(directory,'live'))){
  if(!existsSync(join(directory,'queue',name)))continue;
  try{oldest=Math.min(oldest,statSync(join(directory,'live',name)).mtimeMs);}
  catch(error:any){if(error.code!=='ENOENT')throw error;} // A concurrent flush may seal it.
 }
 return Number.isFinite(oldest)?oldest:undefined;
}

type Plan={schemaVersion:1,sources:string[],name:string,serialized:string};
function complete(directory:string,path:string,plan:Plan) {
 if(plan.schemaVersion!==1||!Array.isArray(plan.sources)||!plan.sources.length||plan.sources.length>200||plan.sources.some(name=>! /^[a-f0-9]{64}\.json$/.test(name))||
   typeof plan.serialized!=='string'||Buffer.byteLength(plan.serialized)>16*1024*1024||plan.name!==hash(plan.serialized)+'.json')throw Error('Invalid live capture seal');
 // A crash anywhere below leaves this manifest. Recovery recreates exactly the
 // same immutable output, even after some source files have already gone.
 atomicFile(join(directory,'queue',plan.name),plan.serialized+'\n');
 for(const name of plan.sources){if(name!==plan.name)remove(join(directory,'queue',name));remove(join(directory,'live',name));}
 syncDirectory(join(directory,'queue'));syncDirectory(join(directory,'live'));
 remove(path);syncDirectory(join(directory,'seals'));
}
/** Caller owns capture:flush. Finish all seals before any attachment or batch
 * HTTP request, so an acknowledged upload can never be reconstructed by a plan. */
export function recoverLiveSeals(directory:string) {
 mkdirSync(join(directory,'live'),{recursive:true});mkdirSync(join(directory,'seals'),{recursive:true});
 for(const name of names(join(directory,'seals'))){const path=join(directory,'seals',name);complete(directory,path,JSON.parse(readFileSync(path,'utf8')));}
}
export function sealLiveBatches(directory:string) {
 recoverLiveSeals(directory);
 const groups=new Map<string,{meta:any,events:any[],attachments:any[],sources:string[],bytes:number}>();
 const seal=(key:string)=>{
  const group=groups.get(key);if(!group)return;
  const serialized=JSON.stringify({...group.meta,events:group.events,attachments:group.attachments});
  const name=hash(serialized)+'.json',path=join(directory,'seals',name),plan:Plan={schemaVersion:1,sources:group.sources,name,serialized};
  atomicJson(path,plan);complete(directory,path,plan);groups.delete(key);
 };
 // Bound memory even when many unrelated sessions recorded within this window.
 let count=0,totalBytes=0;
 const candidates=names(join(directory,'live')).filter(name=>existsSync(join(directory,'queue',name)))
   .map(name=>({name,time:statSync(join(directory,'live',name)).mtimeMs})).sort((a,b)=>a.time-b.time||a.name.localeCompare(b.name));
 for(const {name} of candidates){
  const batch=JSON.parse(readFileSync(join(directory,'queue',name),'utf8'));
  const {events,attachments,...meta}=batch;
  if(!Array.isArray(events)||!events.length||!Array.isArray(attachments))throw Error('Invalid pending live capture');
  const key=JSON.stringify(Object.fromEntries(Object.entries(meta).sort(([a],[b])=>a.localeCompare(b))));
  const bytes=Buffer.byteLength(JSON.stringify(batch)),existing=groups.get(key);
  if(existing&&(existing.events.length+events.length>200||existing.attachments.length+attachments.length>1000||existing.bytes+bytes>4*1024*1024))seal(key);
  const group=groups.get(key)??{meta,events:[],attachments:[],sources:[],bytes:0};
  group.events.push(...events);group.attachments.push(...attachments);group.sources.push(name);group.bytes+=bytes;groups.set(key,group);
  count++;totalBytes+=bytes;
  if(count>=200||totalBytes>=16*1024*1024){for(const key of groups.keys())seal(key);count=0;totalBytes=0;}
 }
 for(const key of groups.keys())seal(key);
}
