import {test,expect} from 'bun:test';
import {Readable,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createZstdDecompress,zstdCompressSync,constants} from 'node:zlib';
import {ZstdFrameValidator} from '../src/capture/zstd-frame.ts';

const u32=(value:number)=>{const bytes=Buffer.alloc(4);bytes.writeUInt32LE(value);return bytes;};
const block=(type:number,size:number,last=true)=>{const bytes=Buffer.alloc(3);bytes.writeUIntLE((size<<3)|(type<<1)|Number(last),0,3);return bytes;};
const raw=(text:string,checksum=false)=>Buffer.concat([u32(0xfd2fb528),Buffer.from([0x20|(checksum?4:0),Buffer.byteLength(text)]),block(0,Buffer.byteLength(text)),Buffer.from(text),...(checksum?[Buffer.alloc(4)]:[])]);
const skip=(text:string,variant=0)=>Buffer.concat([u32(0x184d2a50+variant),u32(Buffer.byteLength(text)),Buffer.from(text)]);
async function validate(parts:Iterable<Buffer>,decode=false){
 const chunks:Buffer[]=[];
 const sink=new Writable({write(chunk,_encoding,callback){chunks.push(chunk);callback();}});
 if(decode)await pipeline(Readable.from(parts),new ZstdFrameValidator(),createZstdDecompress(),sink);
 else await pipeline(Readable.from(parts),new ZstdFrameValidator(),sink);
 return Buffer.concat(chunks);
}

test('standard, concatenated and skippable frames survive arbitrary stream boundaries unchanged',async()=>{
 const bytes=Buffer.concat([skip('metadata'),raw('first\n'),skip('',15),raw('second\n'),skip('tail',8)]);
 for(const width of [1,2,3,5,17,bytes.length]){
  const chunks=[];for(let offset=0;offset<bytes.length;offset+=width)chunks.push(bytes.subarray(offset,offset+width));
  expect(await validate(chunks)).toEqual(bytes);
  expect((await validate(chunks,true)).toString()).toBe('first\nsecond\n');
 }
});

test('every truncated header, payload, checksum and concatenated final frame is rejected',async()=>{
 const frames=[raw('complete JSON\n'),raw('complete JSON\n',true),skip('metadata'),Buffer.concat([u32(0xfd2fb528),Buffer.from([0]),Buffer.from([0]),block(0,0)])];
 for(const frame of frames)for(let end=0;end<frame.length;end++){
  await expect(validate([frame.subarray(0,end)])).rejects.toMatchObject({code:'CAPTURE_ARCHIVE_INVALID'});
  if(end>0)await expect(validate([raw('first\n'),frame.subarray(0,end)])).rejects.toMatchObject({code:'CAPTURE_ARCHIVE_INVALID'});
 }
});

test('optional frame fields, RLE and empty blocks do not require payload buffering',async()=>{
 const prefix=u32(0xfd2fb528);
 // Non-single-segment header: window descriptor, four-byte dictionary ID,
 // eight-byte content size, then an RLE block with one compressed byte.
 const optional=Buffer.concat([prefix,Buffer.from([0xc3]),Buffer.alloc(13),block(1,128*1024),Buffer.from([65])]);
 expect(await validate(Array.from(optional,byte=>Buffer.from([byte])))).toEqual(optional);
 expect(await validate([raw('')])).toEqual(raw(''));
 const many=Buffer.concat([prefix,Buffer.from([0x20,3]),block(0,0,false),block(0,3),Buffer.from('abc')]);
 expect((await validate([many],true)).toString()).toBe('abc');
});

test('reserved fields, oversized blocks and huge incomplete metadata reject safely',async()=>{
 const prefix=u32(0xfd2fb528);
 for(const bytes of [Buffer.from('invalid!'),Buffer.concat([prefix,Buffer.from([0x28,0])]),Buffer.concat([prefix,Buffer.from([0x20,0]),block(3,0)]),Buffer.concat([prefix,Buffer.from([0x20,0]),block(0,128*1024+1)]),Buffer.concat([u32(0x184d2a50),u32(0xffffffff),Buffer.alloc(1024)])]){
  await expect(validate([bytes])).rejects.toMatchObject({code:'CAPTURE_ARCHIVE_INVALID'});
 }
 // The format requires readers to ignore the unused descriptor bit.
 const unused=raw('ok\n');unused[4]!|=16;expect((await validate([unused],true)).toString()).toBe('ok\n');
});

test('native decoding still validates checksums and compressed block contents',async()=>{
 const bytes=zstdCompressSync('verified content\n',{params:{[constants.ZSTD_c_checksumFlag]:1}});
 expect((await validate([bytes],true)).toString()).toBe('verified content\n');
 const broken=Buffer.from(bytes);broken[broken.length-1]!^=1;
 await expect(validate([broken],true)).rejects.toBeDefined();
 await expect(validate([bytes.subarray(0,-1)],true)).rejects.toMatchObject({code:'CAPTURE_ARCHIVE_INVALID'});
});
