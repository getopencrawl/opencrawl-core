import {Transform,type TransformCallback} from 'node:stream';
import {CliError} from '../oauth.ts';

type State='magic'|'descriptor'|'header'|'block'|'payload'|'checksum'|'skip-length'|'skip';
const invalid=(truncated=false)=>new CliError('CAPTURE_ARCHIVE_INVALID',truncated?'Compressed transcript ended inside a Zstandard frame':'Compressed transcript has an invalid Zstandard frame');

/** Node/Bun streaming decoders can accept truncated frames. Validate their
 * framing independently without buffering compressed or expanded content.
 * The decoder remains responsible for block contents and content checksums.
 * Format: https://github.com/meta/zstd/blob/dev/doc/zstd_compression_format.md */
export class ZstdFrameValidator extends Transform {
  private state:State='magic';
  private remaining=4;
  private header=Buffer.alloc(14);
  private used=0;
  private checksum=false;
  private last=false;
  private frames=0;

  private next(state:State,size:number) {this.state=state;this.remaining=size;this.used=0;}
  private complete() {this.frames++;this.next('magic',4);}
  private afterPayload() {
    if(!this.last)this.next('block',3);
    else if(this.checksum)this.next('checksum',4);
    else this.complete();
  }
  private consume(bytes:Buffer,onBoundary:(end:number)=>void) {
    let offset=0;
    while(offset<bytes.length) {
      const count=Math.min(this.remaining,bytes.length-offset);
      const content=this.state==='payload'||this.state==='checksum'||this.state==='skip';
      if(!content){bytes.copy(this.header,this.used,offset,offset+count);this.used+=count;}
      this.remaining-=count;offset+=count;
      if(this.remaining)continue;
      switch(this.state) {
        case 'magic': {
          const magic=this.header.readUInt32LE(0);
          if(magic===0xfd2fb528)this.next('descriptor',1);
          else if(magic>=0x184d2a50&&magic<=0x184d2a5f)this.next('skip-length',4);
          else throw invalid();
          break;
        }
        case 'descriptor': {
          const descriptor=this.header[0]!;
          if(descriptor&8)throw invalid(); // reserved; bit 4 is explicitly ignored by decoders
          const single=Boolean(descriptor&32),sizeFlag=descriptor>>>6;
          this.checksum=Boolean(descriptor&4);
          const dictionaryBytes=[0,1,2,4][descriptor&3]!;
          const contentSizeBytes=sizeFlag===0?(single?1:0):[0,2,4,8][sizeFlag]!;
          this.next('header',(single?0:1)+dictionaryBytes+contentSizeBytes);
          break;
        }
        case 'header':this.next('block',3);break;
        case 'block': {
          const block=this.header.readUIntLE(0,3),type=(block>>>1)&3,size=block>>>3;
          if(type===3||size>128*1024)throw invalid();
          this.last=Boolean(block&1);
          const payload=type===1?1:size;
          if(payload)this.next('payload',payload);else this.afterPayload();
          break;
        }
        case 'payload':this.afterPayload();break;
        case 'checksum':this.complete();break;
        case 'skip-length': {
          const size=this.header.readUInt32LE(0);
          if(size)this.next('skip',size);else this.complete();
          break;
        }
        case 'skip':this.complete();break;
      }
      // Bun's decoder can discard bytes after a completed frame in one write.
      // Preserve each boundary as a separate stream write without buffering it.
      if(this.state==='magic')onBoundary(offset);
    }
  }
  override _transform(chunk:Buffer,encoding:BufferEncoding,callback:TransformCallback) {
    try{
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,encoding);let emitted=0;
      this.consume(bytes,end=>{this.push(bytes.subarray(emitted,end));emitted=end;});
      if(emitted<bytes.length)this.push(bytes.subarray(emitted));
      callback();
    }
    catch(error){callback(error instanceof Error?error:invalid());}
  }
  override _flush(callback:TransformCallback) {
    callback(this.state==='magic'&&this.used===0&&this.frames>0?undefined:invalid(true));
  }
}
