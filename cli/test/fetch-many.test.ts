import {test,expect} from 'bun:test';
import {fetchMany} from '../src/fetch-many.ts';
import {CliError} from '../src/oauth.ts';
import {commandHelp} from '../src/help.ts';

test('ordinary fetch overlaps bounded requests, preserves order and retains successful reads',async()=>{
  let active=0,peak=0;const completed:string[]=[];
  const result=await fetchMany(['a','b','c','d'],2,async id=>{
    peak=Math.max(peak,++active);
    try{await Bun.sleep(id==='a'?20:2);if(id==='c')throw new CliError('BOARD_FORBIDDEN','Access denied',2);completed.push(id);return {text:id};}
    finally{active--;}
  });
  expect(peak).toBe(2);expect(completed[0]).toBe('b');expect(result.partial).toBe(true);
  expect(result.results.map(row=>row.id)).toEqual(['a','b','c','d']);
  expect(result.results[2]).toEqual({id:'c',error:{code:'BOARD_FORBIDDEN',message:'Access denied'}});
  expect(result.results[3]).toEqual({id:'d',data:{text:'d'}});
});
test('invalid concurrency or reference count starts no work; unexpected failures disclose no internals',async()=>{
  let calls=0;const read=async()=>{calls++;throw Error('private diagnostic');};
  for(const size of [0,41])await expect(fetchMany(Array.from({length:size},()=> 'id'),8,read)).rejects.toThrow('1–40');
  for(const n of [0,9,1.5,'bad'])await expect(fetchMany(['id'],n,read)).rejects.toThrow('concurrency');
  expect(calls).toBe(0);
  expect(JSON.stringify(await fetchMany(['id'],1,read))).not.toContain('private diagnostic');
});
test('board fetch help gives the exact output path, limits and ordinary concurrent syntax',()=>{
  const text=commandHelp('board','fetch')!;
  expect(text).toContain('data.text, NOT data.message.text');
  expect(text).toContain('--length 1..8000');
  expect(text).toContain('board fetch message:1185 message:1187');
});
