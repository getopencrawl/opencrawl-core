import {test,expect} from 'bun:test';
import {mkdtempSync,createWriteStream,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createZstdCompress} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {archiveChunks} from '../src/capture/archive.ts';

const LIMIT=48*1024*1024;
for(const extra of [0,1])test(`compressed records ${extra?'above':'at'} the 48 MiB line limit ${extra?'are rejected':'are accepted'}`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'archive-line-limit-')),path=join(root,'history.jsonl.zst');
  try{
    const block=Buffer.alloc(64*1024,120);
    // The short preceding record offsets the large record from decoder chunk
    // boundaries. Its terminating newline can share the chunk crossing the cap.
    await pipeline((async function*(){yield '{}\n';let left=LIMIT+extra-1;while(left){const size=Math.min(left,block.length);yield block.subarray(0,size);left-=size;}yield '\n';})(),createZstdCompress(),createWriteStream(path));
    const sizes:number[]=[];let complete=false;
    const read=async()=>{for await(const bytes of archiveChunks(path,statSync(path).size,value=>{complete=value;}))sizes.push(bytes.length);};
    if(extra){await expect(read()).rejects.toMatchObject({code:'CAPTURE_LINE_TOO_LARGE'});expect(complete).toBe(false);expect(sizes).toEqual([3]);}
    else{await read();expect(complete).toBe(true);expect(sizes).toEqual([3,LIMIT]);}
  }finally{rmSync(root,{recursive:true,force:true});}
},15_000);
