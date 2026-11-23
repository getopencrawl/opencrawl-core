import {test, expect} from 'bun:test';
import {beforeEach, afterEach} from 'bun:test';
import {boardInput, boardRequest, watchBoard, compactDelivery, writeBoardOutput} from '../src/board.ts';
import {CliError} from '../src/oauth.ts';
import {Writable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {utimesSync} from 'node:fs';
import {boardStateFile} from '../src/board.ts';
import {listenerActivity,markNativeBoardActivity} from '../src/board-activity.ts';

let priorTokenOrigin:string|undefined;
beforeEach(()=>{priorTokenOrigin=process.env.OPENCRAWL_API_URL;});
afterEach(()=>{if(priorTokenOrigin===undefined)delete process.env.OPENCRAWL_API_URL;else process.env.OPENCRAWL_API_URL=priorTokenOrigin;});

test('automatic receipts wait for output, retry without duplicates and unlock the next mention',async()=>{
  const order:string[]=[], receipts=['a'.repeat(64),'b'.repeat(64)];let cursor=0, attempts=0;
  await watchBoard({session:'s',emit:async(data:any)=>{order.push(`output${data.id}`);await Promise.resolve();},
    checkpoint:receipt=>{order.push(`checkpoint${receipts.indexOf(receipt)}`);},warn:()=>{},delay:async()=>{},
    request:async()=>cursor===2?{left:true}:{batch:{receipt:receipts[cursor],messages:[{id:cursor,text:cursor?'@agent new mention':'homepage'}]}},
    acknowledge:async receipt=>{order.push(`receipt${receipts.indexOf(receipt)}`);if(attempts++===0)throw new CliError('BOARD_UNAVAILABLE','HTTP 503');cursor++;},
  });
  expect(order).toEqual(['output0','checkpoint0','receipt0','receipt0','output1','checkpoint1','receipt1']);
});

test('restart receipts a flushed checkpoint without replaying it and failed output never receipts',async()=>{
  const receipt='e'.repeat(64);let acknowledgments=0,outputs=0;
  const request=async()=>({batch:{receipt,messages:[{id:1,text:'complete'}]}});
  await watchBoard({session:'s',once:true,lastEmitted:receipt,request,emit:()=>{outputs++;},warn:()=>{},acknowledge:async()=>{acknowledgments++;}});
  expect(outputs).toBe(0);expect(acknowledgments).toBe(1);
  const broken=new Writable({write(_chunk,_encoding,callback){callback(new Error('closed'));}});
  await expect(watchBoard({session:'s',once:true,request,emit:data=>writeBoardOutput(data,true,broken),warn:()=>{},acknowledge:async()=>{acknowledgments++;}})).rejects.toMatchObject({code:'BOARD_OUTPUT_CLOSED'});
  expect(acknowledgments).toBe(1);
});

test('delivery records preserve full Unicode text without transport fragments or author-like mentions',()=>{
  const messages=Array.from({length:8},(_,id)=>({id:id+1,name:'codex:writer',topic:'work',text:'🙂"\n漢字'.repeat(500)}));
  const records=compactDelivery(messages);
  expect(records).toHaveLength(messages.length);
  for(const [index,record]of records.entries()){
    expect(record.text).toBe(messages[index].text);expect(record.from).toBe('codex:writer');
    expect(record).not.toHaveProperty('part');expect(record).not.toHaveProperty('end');
  }
});

test('a complete long message reaches output before its checkpoint and transport receipt',async()=>{
  const message={id:1,name:'codex:writer',topic:'work',text:'詳🧪\n"\\ detail '.repeat(1800)};
  const records:ReturnType<typeof compactDelivery>=[];let checkpointed=false,acked=false;
  await watchBoard({session:'s',once:true,compact:true,request:async()=>({batch:{receipt:'d'.repeat(64),messages:[message]}}),
    emit:data=>{records.push(data as typeof records[number]);expect(checkpointed).toBe(false);expect(acked).toBe(false);},
    delay:async()=>{throw Error('No synthetic chunk delays');},warn:()=>{},
    checkpoint:()=>{expect(records).toHaveLength(1);expect(records[0].text).toBe(message.text);checkpointed=true;},
    acknowledge:async()=>{expect(checkpointed).toBe(true);acked=true;}});
  expect(acked).toBe(true);
});

test('ending a listener during compact output leaves the incomplete delivery unreceipted',async()=>{
  const controller=new AbortController();let parts=0,checkpoints=0,acknowledgments=0;
  await watchBoard({session:'s',once:true,compact:true,signal:controller.signal,
    request:async()=>({batch:{receipt:'d'.repeat(64),messages:[{id:1,name:'sender',topic:'test',text:'x'.repeat(2000)}]}}),
    emit:()=>{parts++;controller.abort();},checkpoint:()=>{checkpoints++;},acknowledge:async()=>{acknowledgments++;},warn:()=>{throw Error('A stopped listener must stay quiet');}});
  expect(parts).toBe(1);expect(checkpoints).toBe(0);expect(acknowledgments).toBe(0);
});

test('closing output while a delivery write is pending rejects it',async()=>{
  const output=new Writable({write(){}});
  const delivery=writeBoardOutput({text:'pending'},true,output);
  output.destroy();
  await expect(delivery).rejects.toMatchObject({code:'BOARD_OUTPUT_CLOSED'});
});

test('transient malformed responses recover; authorization and valid-JSON protocol failures stop',async()=>{
  let calls=0,acks=0;const warnings:string[]=[];
  await watchBoard({session:'s',once:true,request:async()=>{
    if(++calls===1)throw new CliError('INVALID_RESPONSE','HTTP 200 truncated');
    return {batch:{receipt:'f'.repeat(64),messages:[{id:1}]}};
  },emit:()=>{},warn:v=>warnings.push(v),delay:async()=>{},acknowledge:async()=>{acks++;}});
  expect(calls).toBe(2);expect(acks).toBe(1);expect(warnings).toHaveLength(2);
  await expect(watchBoard({session:'s',request:async()=>({batch:{receipt:'bad',messages:[]}}),emit:()=>{},warn:()=>{},acknowledge:async()=>{}})).rejects.toMatchObject({code:'BOARD_PROTOCOL_ERROR',exitCode:2});
});

test('leave racing automatic acknowledgment exits quietly',async()=>{
  let calls=0;
  await watchBoard({session:'s',request:async()=>++calls===1?{batch:{receipt:'f'.repeat(64),messages:[{id:1}]}}:{left:true},
    emit:()=>{},warn:()=>{throw new Error('unexpected retry');},acknowledge:async()=>{throw new CliError('BOARD_CONFLICT','Session has left',2);}});
  expect(calls).toBe(2);
});

test('board client keeps session scope explicit and maps authenticated portable endpoints', async()=>{
  expect(boardInput('subscribe',{session:'native-id',topic:['build']})).toEqual({session:'native-id',topics:['build']});
  expect(()=>boardInput('unknown',{session:'native-id'})).toThrow();
  const old=process.env.OPENCRAWL_TOKEN;process.env.OPENCRAWL_API_URL='http://127.0.0.1:8093';process.env.OPENCRAWL_TOKEN='fixture-only-token';
  try {
    const fetcher=(async(url:any,init:any)=>{
      expect(url).toBe('http://127.0.0.1:8093/api/board/register');
      expect(init.headers.authorization).toBe('Bearer fixture-only-token');expect(init.redirect).toBe('error');
      expect(JSON.parse(init.body)).toEqual({session:'one'});
      return Response.json({schemaVersion:1,data:{agent:'a'}});
    }) as typeof fetch;
    expect(await boardRequest('http://127.0.0.1:8093','register',{session:'one'},fetcher)).toEqual({agent:'a'});
    for(const status of [401,403,404,409,429,503])await expect(boardRequest('http://127.0.0.1:8093','inbox',{},(async()=>Response.json({}, {status})) as unknown as typeof fetch)).rejects.toThrow();
  } finally {if(old===undefined)delete process.env.OPENCRAWL_TOKEN;else process.env.OPENCRAWL_TOKEN=old;}
});

test('quiet watch delivers each receipt once, automatically handles transport acknowledgment, and resumes after transient outages', async()=>{
  let time=0,calls=0;const emitted:any[]=[],warnings:string[]=[],waits:number[]=[];
  const one={receipt:'a'.repeat(64),through:1,messages:[{id:1,text:'change'}]};
  const two={receipt:'b'.repeat(64),through:2,messages:[{id:2,text:'another'}]};
  await watchBoard({acknowledge:async()=>{},session:'s',timeoutMs:65_000,now:()=>time,delay:async ms=>{waits.push(ms);time+=ms;},emit:data=>emitted.push(data),warn:m=>warnings.push(m),request:async()=>{
    calls++;
    if(calls===3)throw new Error('temporary connection failure');
    return {workspace:'team',agent:'agent',batch:calls===1?null:calls<6?one:two,pollAfterMs:10_000};
  }});
  expect(emitted.map(x=>x.id)).toEqual([1,2]);
  expect(emitted[0].text).toBe('change');expect(emitted[0]).not.toHaveProperty('receipt');
  expect(warnings.length).toBe(2);expect(waits.every(ms=>ms>0)).toBe(true);expect(calls).toBeLessThan(10);
});

test('wait exits on a nonempty delivery; revoked access stops immediately rather than retrying forever',async()=>{
  let calls=0;const emitted:any[]=[];
  await watchBoard({acknowledge:async()=>{},session:'s',once:true,emit:v=>emitted.push(v),warn:()=>{},delay:async()=>{},request:async()=>{
    calls++;return {batch:calls===1?null:{receipt:'c'.repeat(64),messages:[{id:1}]}};
  }});
  expect(calls).toBe(2);expect(emitted.length).toBe(1);
  await expect(watchBoard({acknowledge:async()=>{},session:'s',emit:()=>{},warn:()=>{},request:async()=>{throw new CliError('BOARD_FORBIDDEN','Revoked',2);}})).rejects.toThrow('Revoked');
  await expect(watchBoard({acknowledge:async()=>{},session:'s',emit:()=>{},warn:()=>{throw Error('Permission failures must not retry');},request:async()=>{throw new CliError('PERMISSION_DENIED','Allow local state writes.');}})).rejects.toThrow('Allow local state writes.');
});

test('bounded monitor notices never truncate the receipt and fetch binds the exact pending batch',async()=>{
  const emitted:any[]=[];
  const receipt='d'.repeat(64);
  await watchBoard({acknowledge:async()=>{},session:'s'.repeat(200),once:true,notice:'ids',emit:v=>emitted.push(v),warn:()=>{},request:async()=>({batch:{receipt,messages:Array.from({length:8},(_,id)=>({id,text:'x'.repeat(512)}))}})});
  expect(emitted).toEqual([{type:'board.notice',ids:[0,1,2,3,4,5,6,7]}]);
  expect(JSON.stringify({schemaVersion:1,data:emitted[0]}).length).toBeLessThan(200);
  expect(boardInput('inbox',{session:'s',receipt})).toEqual({session:'s',receipt});
});

test('a full notice on a legacy server includes the body and leaves its receipt for the inbox', async () => {
  const notices: unknown[] = [];
  const message = {id: 7, name: 'sender', topic: 'review', text: 'Review complete\n🧪'};
  await watchBoard({session: 'old', once: true, notice: 'full',
    request: async () => ({batch: {receipt: 'f'.repeat(64), messages: [message]}}),
    emit: value => notices.push(value), warn: () => {},
    checkpoint: () => {throw Error('Premature checkpoint');},
    acknowledge: async () => {throw Error('Premature receipt');}});
  expect(notices).toEqual([{type: 'board.notice', ids: [7], messages: compactDelivery([message]), more: false, cursor: null}]);
});

test('channels and root-thread replies use canonical fields, with explicit legacy aliases',()=>{
 expect(boardInput('subscribe',{session:'s',channel:['next'],'channel-mode':'add'})).toEqual({session:'s',topics:['next'],channelMode:'add'});
 expect(boardInput('subscribe',{session:'s',channel:['build']})).toEqual({session:'s',topics:['build']});
 expect(boardInput('publish',{session:'s',id:'r',channel:['build'],thread:'42',text:'Reply'})).toEqual({session:'s',id:'r',topic:'build',threadId:42,text:'Reply',mentions:[]});
 expect(boardInput('thread',{thread:'42',before:'50'})).toEqual({threadId:42,before:50});
 expect(boardInput('channels',{})).toEqual({after:0});
 expect(()=>boardInput('reply',{session:'s',channel:['build'],text:'No root'})).toThrow();
 for(const thread of ['0','-1','1.5','9007199254740992'])expect(()=>boardInput('thread',{thread})).toThrow();
 expect(()=>boardInput('subscribe',{session:'s',channel:['a'],topic:['b']})).toThrow();
 const parts=compactDelivery([{id:43,name:'peer',channel:'opencrawl',threadId:42,text:'Reply'}]);
 expect(parts[0]).toMatchObject({from:'peer',channel:'opencrawl',thread:42,replyTo:42,text:'Reply'});
 expect(compactDelivery([{id:42,name:'opencrawl',channel:'opencrawl',threadId:42,text:'Notice'}])[0]).toMatchObject({from:'opencrawl',thread:42,replyTo:null,text:'Notice'});
});

test('idle shutdown measures 30 minutes from the last new notification or native session activity',async()=>{
 const timeout=30*60_000;
 let now=0,last=0,notifiedAt=0,workedAt=0,exits=0;
 const notices:unknown[]=[];
 await watchBoard({session:'idle',now:()=>now,notice:'ids',acknowledge:async()=>{throw Error('Notice acknowledged');},
   emit:v=>notices.push(v),warn:()=>{},idle:{lastActivity:()=>last,onNotification:()=>{last=notifiedAt=now;},leave:async()=>{exits++;}},
   request:async()=>({batch:now>=60_000?{receipt:'d'.repeat(64),messages:[{id:1}]}:null}),
   delay:async ms=>{now+=ms;if(!workedAt&&now>=timeout){last=workedAt=now;}if(now>3*timeout)throw Error('Poll kept the listener alive');}});
 expect(notices).toEqual([{type:'board.notice',ids:[1]}]);expect(notifiedAt).toBeGreaterThanOrEqual(60_000);
 expect(now).toBe(workedAt+timeout);expect(exits).toBe(1);
});

test('monitor expiry, rearming and replay preserve the native session idle clock',()=>{
 const api='https://board.example',session=randomUUID(),watch=listenerActivity(api,session);
 const marker=boardStateFile(api,session).replace(/\.json$/,'.activity'),base=new Date(1_700_000_000_000);
 const receipt='d'.repeat(64);watch.onNotification(receipt);utimesSync(marker,base,base);
 const resumed=listenerActivity(api,session);resumed.onNotification(receipt);
 for(const event of [
   {hook_event_name:'PreToolUse',tool_name:'Monitor',tool_input:{command:'opencrawl board watch --notify-only --json'}},
   {hook_event_name:'PostToolUse',tool_name:'ToolSearch',tool_input:{query:'select:Monitor,TaskStop'}},
   {hook_event_name:'Stop'},
 ])markNativeBoardActivity(api,{session_id:session,...event});
 expect(resumed.lastActivity()).toBe(base.getTime());
 markNativeBoardActivity(api,{session_id:session,hook_event_name:'UserPromptSubmit',prompt:'Continue testing'});
 expect(resumed.lastActivity()).toBeGreaterThan(base.getTime());
 utimesSync(marker,base,base);
 markNativeBoardActivity(api,{session_id:session,hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'git status'}});
 expect(resumed.lastActivity()).toBeGreaterThan(base.getTime());
});

const arrival = (id: number, extra: Record<string, unknown> = {}) =>
  ({id, from: 'peer', channel: 'presence', thread: id, replyTo: null, time: 't', text: 'peer is online', mentions: [], ...extra});

test('a page of unaddressed arrivals is receipted by cursor without waking the chat', async () => {
  const notices: any[] = [], receipts: string[] = [], cursor = 'a'.repeat(64), next = 'b'.repeat(64);
  const pages = [
    {batch: {receipt: '1'.repeat(64), messages: [arrival(1), arrival(2)], cursor, more: true}},
    {batch: {receipt: '2'.repeat(64), messages: [arrival(3)], cursor: next, more: false}},
    {batch: {receipt: '3'.repeat(64), messages: [{...arrival(4), channel: 'fleet', text: 'Review this'}], cursor, more: false}},
  ];
  const waits: number[] = [];
  await watchBoard({session: 's', once: true, notice: 'full', request: async () => pages.shift(),
    emit: value => notices.push(value), warn: () => {}, delay: async ms => {waits.push(ms);},
    acknowledge: async () => {throw Error('Notice receipted by batch');},
    acknowledgeRoutine: async value => {receipts.push(value);}});
  expect(receipts).toEqual([cursor, next]);
  expect(notices.map(notice => notice.ids)).toEqual([[4]]);
  // The quiet arrivals reach the chat with the next notice it has to read anyway.
  expect(notices[0].arrivals).toEqual([1, 2, 3].map(id => ({id, from: 'peer', time: 't', text: 'peer is online'})));
  // The second page follows the first immediately; only the drained inbox waits.
  expect(waits).toHaveLength(1);
});

test('a mention, a reply, a mixed page or an opt-in still delivers arrivals', async () => {
  const cursor = 'c'.repeat(64);
  const deliver = async (messages: unknown[], quiet = true, page: Record<string, unknown> = {cursor, more: false}) => {
    const notices: any[] = [];
    await watchBoard({session: 's', once: true, notice: 'full',
      request: async () => ({batch: {receipt: 'd'.repeat(64), messages, ...page}}),
      emit: value => notices.push(value), warn: () => {}, acknowledge: async () => {},
      ...(quiet ? {acknowledgeRoutine: async () => {throw Error('Deliverable page receipted silently');}} : {})});
    return notices.length;
  };
  expect(await deliver([arrival(1, {mentions: ['me']})])).toBe(1);
  expect(await deliver([arrival(1, {replyTo: 9})])).toBe(1);
  expect(await deliver([arrival(1), arrival(2, {channel: 'fleet'})])).toBe(1);
  expect(await deliver([arrival(1, {mentions: undefined})])).toBe(1);
  expect(await deliver([arrival(1)], false)).toBe(1);
  // A legacy page has no cursor to receipt, so it is delivered as before.
  expect(await deliver([arrival(1)], true, {})).toBe(1);
});

test('a failed silent receipt retries the same page and never drops it', async () => {
  const receipts: string[] = [], warnings: string[] = [], cursor = 'e'.repeat(64);
  let calls = 0;
  await watchBoard({session: 's', notice: 'full', delay: async () => {}, emit: () => {throw Error('Arrival delivered');},
    warn: message => warnings.push(message), acknowledge: async () => {},
    request: async () => ++calls < 3 ? {batch: {receipt: 'f'.repeat(64), messages: [arrival(1)], cursor, more: false}} : {left: true},
    acknowledgeRoutine: async value => {receipts.push(value); if (receipts.length === 1) throw Error('offline');}});
  expect(receipts).toEqual([cursor, cursor]);
  expect(warnings).toEqual(['Board connection unavailable; retrying with backoff.', 'Board connection restored.']);
});

test('quiet arrivals are reported once and bounded to the most recent', async () => {
  const notices: any[] = [], cursor = 'a'.repeat(64);
  const real = (id: number) => ({batch: {receipt: String(id % 10).repeat(64), messages: [{...arrival(id), channel: 'fleet'}], cursor, more: false}});
  const pages: any[] = [
    {batch: {receipt: '1'.repeat(64), messages: Array.from({length: 60}, (_, id) => arrival(id + 1)), cursor, more: true}},
    real(102), real(103), {left: true},
  ];
  await watchBoard({session: 's', notice: 'full', request: async () => pages.shift(), delay: async () => {},
    emit: value => notices.push(value), warn: () => {}, acknowledge: async () => {}, acknowledgeRoutine: async () => {}});
  expect(notices[0].arrivals.map((entry: {id: number}) => entry.id)).toEqual(Array.from({length: 50}, (_, index) => index + 11));
  expect(notices[1]).not.toHaveProperty('arrivals');
});
