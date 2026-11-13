import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claudeReplicasActors,createReplicasAttribution,replicasEventAttribution} from '../src/capture/replicas.ts';
import {finalizeEventIdentity} from '../src/capture/parse.ts';

const workspace='10000000-0000-4000-8000-000000000001',session='20000000-0000-4000-8000-000000000001',chat='30000000-0000-4000-8000-000000000001';
const first='40000000-0000-4000-8000-000000000001',second='40000000-0000-4000-8000-000000000002',alice='50000000-0000-4000-8000-000000000001',bob='50000000-0000-4000-8000-000000000002';
const history=()=>({thread_id:session,coding_agent:'claude',events:[{type:'claude-user',payload:{uuid:first,replicasMessageId:'user-1'}},{type:'claude-user',payload:{uuid:second,replicasMessageId:'user-2'}}],senders:[{message_id:'user-2',sender_user_id:bob,sender_display_name:'Bob'},{message_id:'user-1',sender_user_id:alice,sender_display_name:'Alice'}],has_more:false});

test('shared Claude input maps exact native IDs to each platform sender, never creator or order',()=>{
 const actors=claudeReplicasActors(history(),workspace,session);
 expect(actors.get(first)).toMatchObject({userId:alice,name:'Alice',messageId:'user-1',assurance:'collector-reported'});
 expect(actors.get(second)).toMatchObject({userId:bob,name:'Bob',messageId:'user-2'});
 const unknown=history();unknown.senders=[];
 expect(claudeReplicasActors(unknown,workspace,session).get(first)).toMatchObject({kind:'unknown'});
 expect(claudeReplicasActors(unknown,workspace,session).get(first)?.userId).toBeUndefined();
 expect(()=>claudeReplicasActors({...history(),thread_id:chat},workspace,session)).toThrow('provenance');
 const conflict=history();conflict.senders.push({...conflict.senders[0]!,message_id:'user-1'});
 expect(()=>claudeReplicasActors(conflict,workspace,session)).toThrow('provenance');
});

test('profile labels cannot change content-bound event identity',()=>{
 const actor=claudeReplicasActors(history(),workspace,session).get(first)!;
 const make=(name:string)=>{const attribution=replicasEventAttribution({...actor,name});return {event:finalizeEventIdentity({id:first,kind:'message',data:{role:'user',content:'Hello'},actor:attribution.actor}),profile:attribution.profile};};
 expect(make('Alice').event).toEqual(make('Renamed').event);
 expect(make('Alice').profile).not.toEqual(make('Renamed').profile);
});

test('attribution survives retry, paging and collector restart without requiring another API read',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'oc-replicas-actors-'));
 try{
  let fail=true;const calls:string[][]=[];
  const run=async(args:string[])=>{calls.push(args);if(args[0]==='chat')return {chats:[{id:chat,provider:'claude'}]};if(fail)throw Error('offline');if(args.includes('--before'))return history();return {...history(),events:[],senders:[],has_more:true,before_cursor:'page-two'};};
  const lookup=createReplicasAttribution({run,directory:()=>dir});
  await expect(lookup(workspace,session,first)).rejects.toThrow('cursor is retained');
  fail=false;
  expect((await lookup(workspace,session,first))?.userId).toBe(alice);
  expect(calls.some(args=>args.includes('page-two'))).toBe(true);
  const restarted=createReplicasAttribution({run:async()=>{throw Error('must use durable cache');},directory:()=>dir});
  expect((await restarted(workspace,session,second))?.userId).toBe(bob);
  writeFileSync(join(dir,readdirSync(dir)[0]!),'{invalid');
  await expect(createReplicasAttribution({run,directory:()=>dir})(workspace,session,first)).rejects.toThrow('provenance');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a known platform chat with missing input mapping fails visibly; native-only sessions remain unclaimed',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'oc-replicas-actors-'));
 try{
  const lookup=createReplicasAttribution({directory:()=>dir,run:async args=>args[0]==='chat'?{chats:[{id:chat,provider:'claude'}]}:{...history(),events:[]}});
  await expect(lookup(workspace,session,first)).rejects.toThrow('provenance');
  const nativeOnly=createReplicasAttribution({directory:()=>dir,run:async()=>({chats:[]})});
  expect(await nativeOnly(workspace,session,first)).toBeUndefined();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('an exact native control record without a platform input remains unattributed across retries',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'oc-replicas-control-'));
 try{
  const control={type:'claude-user',payload:{uuid:first,message:{role:'user',content:[{type:'text',text:'[Request interrupted by user]'}]}}};
  const calls:string[][]=[];
  const run=async(args:string[])=>{calls.push(args);return args[0]==='chat'?{chats:[{id:chat,provider:'claude'}]}:args.includes('--before')?{...history(),events:[]}:{...history(),events:[control],has_more:true,before_cursor:'older'};};
  const lookup=createReplicasAttribution({run,directory:()=>dir});
  expect(await lookup(workspace,session,first)).toBeUndefined();
  expect(calls.some(args=>args.includes('older'))).toBe(true);
  const restarted=createReplicasAttribution({directory:()=>dir,run:async()=>{throw Error('must retain first observation');}});
  expect(await restarted(workspace,session,first)).toBeUndefined();
  // A real input with the same text still uses its explicit sender link.
  const other=createReplicasAttribution({directory:()=>dir,run:async()=>({...history(),events:[{...control,payload:{...control.payload,uuid:second,replicasMessageId:'user-2'}}]})});
  expect((await other(workspace,session,second))?.userId).toBe(bob);
  expect(await other(workspace,session,first)).toBeUndefined();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a malformed platform ID or incomplete history cannot become a durable unattributed record',async()=>{
 for(const extra of [{replicasMessageId:null},{replicasMessageId:''},{replicasMessageId:42},{}]){
  const dir=mkdtempSync(join(tmpdir(),'oc-replicas-control-invalid-'));
  try{
   const lookup=createReplicasAttribution({directory:()=>dir,run:async args=>args[0]==='chat'?{chats:[{id:chat,provider:'claude'}]}:{...history(),events:[{type:'claude-user',payload:{uuid:first,...extra}}],has_more:Object.keys(extra).length?false:undefined}});
   await expect(lookup(workspace,session,first)).rejects.toThrow('cursor is retained');
   expect(readdirSync(dir)).toEqual([]);
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
});
