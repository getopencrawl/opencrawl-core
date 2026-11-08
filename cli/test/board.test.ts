import {test, expect} from 'bun:test';
import {boardInput, boardRequest, participationInstructions, watchBoard} from '../src/board.ts';
import {CliError} from '../src/oauth.ts';

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

test('quiet watch delivers each receipt once, leaves acknowledgment to the agent, and resumes after transient outages', async()=>{
  let time=0,calls=0;const emitted:any[]=[],warnings:string[]=[],waits:number[]=[];
  const one={receipt:'a'.repeat(64),through:1,messages:[{id:1,text:'change'}]};
  const two={receipt:'b'.repeat(64),through:2,messages:[{id:2,text:'another'}]};
  await watchBoard({session:'s',timeoutMs:65_000,now:()=>time,delay:async ms=>{waits.push(ms);time+=ms;},emit:data=>emitted.push(data),warn:m=>warnings.push(m),request:async()=>{
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
  await watchBoard({session:'s',once:true,emit:v=>emitted.push(v),warn:()=>{},delay:async()=>{},request:async()=>{
    calls++;return {batch:calls===1?null:{receipt:'c'.repeat(64),messages:[{id:1}]}};
  }});
  expect(calls).toBe(2);expect(emitted.length).toBe(1);
  await expect(watchBoard({session:'s',emit:()=>{},warn:()=>{},request:async()=>{throw new CliError('BOARD_FORBIDDEN','Revoked',2);}})).rejects.toThrow('Revoked');
  await expect(watchBoard({session:'s',emit:()=>{},warn:()=>{throw Error('Permission failures must not retry');},request:async()=>{throw new CliError('PERMISSION_DENIED','Allow local state writes.');}})).rejects.toThrow('Allow local state writes.');
});

test('installed participation instructions describe native delivery and consumption acknowledgments',()=>{
  const text=participationInstructions('https://example.com');
  for(const phrase of ['board register','board watch','board ack','board leave','Monitor','notify(output)','tty:false','Deduplicate','native session ID','not a detached shell alone'])expect(text).toContain(phrase);
});

test('bounded monitor notices never truncate the receipt and fetch binds the exact pending batch',async()=>{
  const emitted:any[]=[];
  const receipt='d'.repeat(64);
  await watchBoard({session:'s'.repeat(200),once:true,notifyOnly:true,emit:v=>emitted.push(v),warn:()=>{},request:async()=>({batch:{receipt,messages:Array.from({length:8},(_,id)=>({id,text:'x'.repeat(512)}))}})});
  expect(emitted).toEqual([{type:'board.notice',receipt,count:8}]);
  expect(JSON.stringify({schemaVersion:1,data:emitted[0]}).length).toBeLessThan(200);
  expect(boardInput('inbox',{session:'s',receipt})).toEqual({session:'s',receipt});
});
