import {CliError} from '../oauth.ts';
import {hash} from './parse.ts';

const blockSize=1024*1024;
const maxLineBytes=48*1024*1024;

/** Fingerprint fixed-size blocks so import can verify each byte it actually
 * passes to the parser, even if a writer edits the source after preflight. */
export async function* historyBlocks(chunks:AsyncIterable<Buffer>,review:(digest:string,index:number)=>void){
  let parts:Buffer[]=[],used=0,index=0;
  function take(){
    const block=parts.length===1?parts[0]:Buffer.concat(parts,used);
    review(hash(block),index++);
    parts=[];used=0;
    return block;
  }
  for await(const chunk of chunks){
    for(let start=0;start<chunk.length;){
      const count=Math.min(blockSize-used,chunk.length-start);
      parts.push(chunk.subarray(start,start+count));used+=count;start+=count;
      if(used===blockSize)yield take();
    }
  }
  if(used)yield take();
}

/** Only complete records are importable. Keep an unfinished record bounded even
 * when it spans many blocks, without copying its growing prefix repeatedly. */
export async function* historyLineChunks(blocks:AsyncIterable<Buffer>){
  let tail:Buffer[]=[],length=0;
  for await(const block of blocks){
    const first=block.indexOf(10);
    if(length+(first<0?block.length:first)>=maxLineBytes)throw new CliError('CAPTURE_LINE_TOO_LARGE','Transcript line exceeds the capture limit.');
    if(first<0){tail.push(block);length+=block.length;continue;}
    const end=block.lastIndexOf(10)+1,complete=block.subarray(0,end);
    yield length?Buffer.concat([...tail,complete],length+end):complete;
    length=block.length-end;tail=length?[block.subarray(end)]:[];
  }
}
