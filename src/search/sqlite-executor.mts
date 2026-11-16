import {fork} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import type {SqliteCommand,SqliteReply} from './sqlite-protocol.mjs';
const fail=(message:string,code:string,notApplied=false)=>Object.assign(new Error(message),{status:503,code,...(notApplied?{writeOutcome:'not-applied' as const}:{})});
const timeout=(notApplied=false)=>fail('SQLite search exceeded timeout','SQLITE_DEADLINE',notApplied);
const DEFAULT_TIMEOUT=30_000;
export function sqliteSearchDeadline(value:unknown):number{
 if(value===undefined)return DEFAULT_TIMEOUT;
 const match=typeof value==='string'&&/^(\d+)(ms|s)$/.exec(value);
 const millis=match?Number(match[1])*(match[2]==='s'?1000:1):NaN;
 if(!Number.isSafeInteger(millis)||millis<0)throw Object.assign(new Error('Unsupported SQLite search operation: timeout (use milliseconds or seconds)'),{status:400});
 // Operator engine budgets are bounded even if a domain query requests longer.
 return Math.min(millis,DEFAULT_TIMEOUT);
}
interface Job {id:number;command:SqliteCommand;deadline:number;timer:ReturnType<typeof setTimeout>;resolve:(value:unknown)=>void;reject:(error:unknown)=>void;slot?:Slot;failure?:Error}
interface Slot {child:ChildProcess;job?:Job;stopping:boolean;tasks:number;started:number;idle?:ReturnType<typeof setTimeout>;exited:Promise<void>;resolveExit:()=>void}
/** Global bound applies across tenant resolvers and both reads/writes. SIGKILL
 * interrupts native SQLite waits too; slot reuse waits for the observed exit.
 * A lost response after dispatch is deliberately never marked not-applied. */
export function createSqliteExecutor({maxWorkers=2,maxQueue=64,idleTimeoutMs=1000,maxTasks=256,maxLifetimeMs=300_000,defaultTimeoutMs=DEFAULT_TIMEOUT,workerUrl=new URL('./sqlite-worker.mjs',import.meta.url)}={}){
 for(const [name,value,max] of [['maxWorkers',maxWorkers,8],['maxQueue',maxQueue,1024],['idleTimeoutMs',idleTimeoutMs,60_000],['maxTasks',maxTasks,10000],['maxLifetimeMs',maxLifetimeMs,3600_000],['defaultTimeoutMs',defaultTimeoutMs,DEFAULT_TIMEOUT]] as const)if(!Number.isSafeInteger(value)||value<1||value>max)throw new Error('Invalid SQLite executor '+name);
 const slots=new Set<Slot>(),queue:Job[]=[];let sequence=0,closed=false;
 const terminateAll=()=>{for(const slot of slots)slot.child.kill('SIGKILL');};
 process.once('exit',terminateAll);
 function finish(job:Job,error:unknown,result?:unknown){clearTimeout(job.timer);if(error)job.reject(error);else job.resolve(result);}
 function stop(slot:Slot,failure?:Error){
  if(slot.stopping)return;
  slot.stopping=true;clearTimeout(slot.idle);
  if(slot.job)slot.job.failure??=failure??fail('SQLite worker stopped before its result was acknowledged','SQLITE_WORKER_LOST');
  // Keep the process referenced until its exit confirms termination and reaping.
  slot.child.ref();slot.child.channel?.ref();slot.child.kill('SIGKILL');
 }
 function idle(slot:Slot){
  if(closed||slot.tasks>=maxTasks||performance.now()-slot.started>=maxLifetimeMs){stop(slot);return;}
  slot.idle=setTimeout(()=>stop(slot),idleTimeoutMs);slot.idle.unref();
  slot.child.unref();slot.child.channel?.unref();
 }
 function spawn():Slot{
  const child=fork(workerUrl,[],{env:{},execArgv:[],serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']});
  let resolveExit!:()=>void;const exited=new Promise<void>(resolve=>{resolveExit=resolve;});
  const slot:Slot={child,stopping:false,tasks:0,started:performance.now(),exited,resolveExit};slots.add(slot);
  child.on('message',(raw:unknown)=>{
   const reply=raw as SqliteReply,job=slot.job;
   if(!job||!reply||reply.id!==job.id||!('result' in reply||'error' in reply)){stop(slot);return;}
   if('error' in reply&&(!reply.error||typeof reply.error.message!=='string')){stop(slot);return;}
   if(slot.stopping)return;
   if(performance.now()>=job.deadline){stop(slot,timeout());return;}
   slot.job=undefined;job.slot=undefined;slot.tasks++;
   const error='error' in reply?Object.assign(new Error(reply.error.message),reply.error):undefined;
   finish(job,error,'result' in reply?reply.result:undefined);idle(slot);pump();
  });
  child.on('error',()=>stop(slot));
  child.on('disconnect',()=>{if(!slot.stopping)stop(slot);});
  // close also fires when spawn itself fails, unlike exit. No pipes are exposed.
  child.once('close',()=>{
   clearTimeout(slot.idle);slots.delete(slot);
   if(slot.job){finish(slot.job,slot.job.failure??fail('SQLite worker exited before its result was acknowledged','SQLITE_WORKER_LOST'));slot.job=undefined;}
   slot.resolveExit();pump();
  });
  return slot;
 }
 function pump(){
  if(closed)return;
  while(queue.length){
   if(performance.now()>=queue[0].deadline){finish(queue.shift()!,timeout(true));continue;}
   let slot=[...slots].find(s=>!s.job&&!s.stopping);
   if(!slot&&slots.size<maxWorkers)try{slot=spawn();}catch{finish(queue.shift()!,fail('SQLite worker could not start','SQLITE_WORKER_START',true));continue;}
   if(!slot)return;
   const job=queue.shift()!;
   clearTimeout(slot.idle);slot.job=job;job.slot=slot;slot.child.ref();slot.child.channel?.ref();
   try{slot.child.send({id:job.id,command:job.command},error=>{if(error&&slot!.job===job)stop(slot!);});}catch{stop(slot);}
  }
 }
 return {
  run<T>(command:SqliteCommand,timeoutMs=defaultTimeoutMs):Promise<T>{
   if(closed)return Promise.reject(fail('SQLite executor is closed','SQLITE_EXECUTOR_CLOSED',true));
   if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>DEFAULT_TIMEOUT)return Promise.reject(new Error('Invalid SQLite operation timeout'));
   if(!timeoutMs)return Promise.reject(timeout(true));
   if(queue.length>=maxQueue)return Promise.reject(fail('SQLite operation queue is full','SQLITE_QUEUE_FULL',true));
   const deadline=performance.now()+timeoutMs;let snapshot:SqliteCommand;
   // Snapshot prior to admission: caller mutations cannot cross tenant scopes.
   try{snapshot=structuredClone(command);}catch{return Promise.reject(fail('SQLite request cannot be transferred','SQLITE_REQUEST_INVALID',true));}
   return new Promise<T>((resolve,reject)=>{
    const job:Job={id:++sequence,command:snapshot,deadline,resolve:resolve as (value:unknown)=>void,reject,timer:setTimeout(()=>{
     if(job.slot)stop(job.slot,timeout());else{const i=queue.indexOf(job);if(i>=0)queue.splice(i,1);finish(job,timeout(true));}
    },Math.max(0,deadline-performance.now()))};
    queue.push(job);pump();
   });
  },
  async close(){
   closed=true;for(const job of queue.splice(0))finish(job,fail('SQLite executor is closed','SQLITE_EXECUTOR_CLOSED',true));
   for(const slot of slots)stop(slot);
   await Promise.all([...slots].map(slot=>slot.exited));process.removeListener('exit',terminateAll);
  },
  // Operational counters expose no tenant, SQL, query or document data.
  inspect(){return {workers:slots.size,busy:[...slots].filter(s=>!!s.job).length,queued:queue.length,pids:[...slots].map(s=>s.child.pid).filter((pid):pid is number=>pid!==undefined)};},
 };
}
let shared:ReturnType<typeof createSqliteExecutor>|undefined;
export const sqliteExecutor=()=>shared??=createSqliteExecutor();
