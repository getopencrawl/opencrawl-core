import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';

export const recordingChannel='opencrawl_recording_changed';
export const recordingKey=(scope:readonly string[])=>createHash('sha256').update(JSON.stringify(scope)).digest('hex');

/** One LISTEN socket per receiver with sleeping capture clients. The notification
 * is a wake-up only; every decision still comes from authenticated durable state. */
export function recordingNotifications(pool:Pool){
  const waiters=new Map<string,Set<()=>void>>();
  let socket:PoolClient|undefined,connecting:Promise<void>|undefined;
  const wakeAll=()=>{for(const group of waiters.values())for(const wake of group)wake();};
  async function connect(){
    if(socket)return;
    connecting??=(async()=>{
      const client=await pool.connect();
      const lost=()=>{if(socket===client){socket=undefined;client.release(true);}wakeAll();};
      client.on('error',lost);
      client.on('end',lost);
      client.on('notification',msg=>{if(msg.channel===recordingChannel&&msg.payload)for(const wake of waiters.get(msg.payload)??[])wake();});
      try{await client.query('LISTEN '+recordingChannel);socket=client;}
      catch(error){client.release(true);throw error;}
    })().finally(()=>{connecting=undefined;});
    return connecting;
  }
  return async (key:string,signal:AbortSignal,remaining:()=>Promise<number>)=>{
    let wake!:()=>void;
    const notification=new Promise<void>(resolve=>{wake=resolve;});
    const group=waiters.get(key)??new Set();
    waiters.set(key,group); group.add(wake);
    let timer:ReturnType<typeof setTimeout>|undefined;
    signal.addEventListener('abort',wake,{once:true});
    try{
      await connect();
      // Subscribe before checking the revision to cover a toggle on either side of LISTEN.
      const ms=await remaining();
      if(ms>0&&!signal.aborted){
        timer=setTimeout(wake,Math.min(50_000,ms));
        await notification;
      }
    }finally{
      clearTimeout(timer);signal.removeEventListener('abort',wake);group.delete(wake);
      if(!group.size)waiters.delete(key);
      if(!waiters.size&&socket){const client=socket;socket=undefined;client.release(true);}
    }
  };
}
