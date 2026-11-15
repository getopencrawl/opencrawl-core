import {createReadStream} from 'node:fs';
import {createZstdDecompress} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {CliError} from '../oauth.ts';
import {ZstdFrameValidator} from './zstd-frame.ts';

const TARGET_BYTES=8*1024*1024,MAX_LINE_BYTES=48*1024*1024;

/** Decompress with backpressure, retaining only a bounded group of complete
 * records. No expanded file is required, and offsets remain decompressed bytes.
 * The caller publishes archive completion only after framing and decoding finish. */
export async function* archiveChunks(path:string,sourceBytes:number,onComplete:(complete:boolean)=>void) {
 const input=createReadStream(path,{end:Math.max(0,sourceBytes-1)}),decoder=createZstdDecompress();
 const completion=pipeline(input,new ZstdFrameValidator(),decoder);void completion.catch(()=>{});
 let parts:Buffer[]=[],size=0,nextRead=TARGET_BYTES,lineBytes=0;
 try {
  for await(const chunk of decoder) {
   const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
   for(let start=0;start<bytes.length;){
    const end=bytes.indexOf(10,start);lineBytes+=(end<0?bytes.length:end+1)-start;
    // Count the newline too, matching the bounded plain-transcript reader.
    // A decoder chunk can contain the newline just after crossing the limit.
    if(lineBytes>MAX_LINE_BYTES||end<0&&lineBytes===MAX_LINE_BYTES)throw new CliError('CAPTURE_LINE_TOO_LARGE','Transcript line exceeds capture chunk size');
    if(end<0)break;
    lineBytes=0;start=end+1;
   }
   parts.push(bytes);size+=bytes.length;
   if(size<nextRead)continue;
   const buffered=Buffer.concat(parts,size),end=buffered.lastIndexOf(10);
   if(end<0) {
    if(size>=MAX_LINE_BYTES)throw new CliError('CAPTURE_LINE_TOO_LARGE','Transcript line exceeds capture chunk size');
    // Grow geometrically for a single long record, avoiding quadratic copies.
    nextRead=Math.min(MAX_LINE_BYTES,nextRead*2);continue;
   }
   yield buffered.subarray(0,end+1);
   const tail=buffered.subarray(end+1);parts=tail.length?[tail]:[];size=tail.length;nextRead=TARGET_BYTES;
  }
  await completion;
  if(size) {
   const buffered=Buffer.concat(parts,size),end=buffered.lastIndexOf(10);
   if(end>=0){yield buffered.subarray(0,end+1);size-=end+1;}
  }
  // Preserve an incomplete final native record for a later corrected archive.
  onComplete(size===0);
 }finally{input.destroy();decoder.destroy();await completion.catch(()=>{});}
}
