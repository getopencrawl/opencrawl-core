import {test, expect} from 'bun:test';
import {boardInput, boardRequest, participationInstructions, watchBoard, compactDelivery, writeBoardOutput} from '../src/board.ts';
import {CliError} from '../src/oauth.ts';
import {Writable} from 'node:stream';

test('automatic receipts wait for output, retry without duplicates and unlock the next mention',async()=>{
  const order:string[]=[], receipts=['a'.repeat(64),'b'.repeat(64)];let cursor=0, attempts=0;
  await watchBoard({session:'s',emit:async(data:any)=>{order.push(`output${data.messages[0].id}`);await Promise.resolve();},
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

test('compact monitor output preserves every character and fits bounded notification lines',()=>{
  const messages=Array.from({length:8},(_,id)=>({id:id+1,name:'codex:'+ 'n'.repeat(74),topic:'t'.repeat(80),text:'🙂\\"\n漢字'.repeat(50)}));
  const parts=compactDelivery(messages);
  for(const part of parts)expect(Buffer.byteLength(JSON.stringify({schemaVersion:1,data:part}))).toBeLessThanOrEqual(400);
  for(const msg of messages){
    const found=parts.filter(p=>p.id===msg.id);
    expect(found.map(p=>p.text).join('')).toBe(`@${msg.name} [${msg.topic}] ${msg.text}`);
    expect(found.filter(p=>p.end)).toHaveLength(1);
    expect(found.at(-1)?.end).toBe(true);
  }
});

test('compact bursts stay below the native monitor aggregate cap and refill rate',async()=>{
  let bytes=0,maximum=0;const waits:number[]=[];let acked=false;
  await watchBoard({session:'s',once:true,compact:true,request:async()=>({batch:{receipt:'d'.repeat(64),messages:Array.from({length:8},(_,id)=>({id,name:'n'.repeat(80),topic:'t'.repeat(80),text:'x'.repeat(512)}))}}),
    emit:data=>{bytes+=Buffer.byteLength(JSON.stringify({schemaVersion:1,data})) + 1;maximum=Math.max(maximum,bytes);},
    delay:async ms=>{waits.push(ms);bytes=0;},warn:()=>{},acknowledge:async()=>{acked=true;}});
  expect(maximum).toBeLessThanOrEqual(2400);expect(waits.length).toBeGreaterThan(0);
  expect(waits.every(ms=>ms>=2500)).toBe(true);expect(acked).toBe(true);
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
  expect(boardInput('subscribe',{session:'native-id',topic:['build']})).toEqual({session:'native-id',topics:['build'],homepage:true});
  expect(boardInput('subscribe',{session:'native-id','no-homepage':true})).toEqual({session:'native-id',topics:[],homepage:false});
  expect(()=>boardInput('unknown',{session:'native-id'})).toThrow();
  const old=process.env.OPENCRAWL_TOKEN;process.env.OPENCRAWL_TOKEN='fixture-only-token';
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
  expect(emitted.map(x=>x.receipt)).toEqual([one.receipt,two.receipt]);
  expect(emitted[0].session).toBe('s');expect(emitted[0].type).toBe('board.delivery');
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

test('installed participation instructions describe native delivery without model-managed acknowledgments',()=>{
  const text=participationInstructions('https://example.com');
  for(const phrase of ['board register','board watch','automatically','board leave','Monitor','notify(output)','tty:false','Deduplicate','native session ID','not a detached shell alone'])expect(text).toContain(phrase);
});

test('bounded monitor notices never truncate the receipt and fetch binds the exact pending batch',async()=>{
  const emitted:any[]=[];
  const receipt='d'.repeat(64);
  await watchBoard({acknowledge:async()=>{},session:'s'.repeat(200),once:true,notifyOnly:true,emit:v=>emitted.push(v),warn:()=>{},request:async()=>({batch:{receipt,messages:Array.from({length:8},(_,id)=>({id,text:'x'.repeat(512)}))}})});
  expect(emitted).toEqual([{type:'board.notice',receipt,count:8}]);
  expect(JSON.stringify({schemaVersion:1,data:emitted[0]}).length).toBeLessThan(200);
  expect(boardInput('inbox',{session:'s',receipt})).toEqual({session:'s',receipt});
});
