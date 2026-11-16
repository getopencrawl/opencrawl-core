import {readSync,fstatSync} from 'node:fs';
import {CliError} from '../oauth.ts';
import {createHash} from 'node:crypto';

/** Bounded fingerprint immediately before a saved byte boundary. Never parse
 * pre-consent messages or read the whole transcript to detect a rewritten tail. */
export function transcriptCheckpoint(fd:number,end:number) {
  const bytes=Buffer.alloc(Math.min(end,1024)),count=readSync(fd,bytes,0,bytes.length,end-bytes.length);
  return createHash('sha256').update(bytes.subarray(0,count)).digest('hex');
}

/** Keep native file IDs exact: Windows IDs may exceed Number's safe range. */
export function transcriptIdentity(fd:number):string {
  const stat=fstatSync(fd,{bigint:true});
  if(typeof stat.dev!=='bigint'||typeof stat.ino!=='bigint'||stat.dev<0n||stat.ino<=0n||!stat.isFile())
    throw new CliError('CAPTURE_FILE_IDENTITY_UNAVAILABLE','The filesystem did not provide an exact file identity. Capture is paused; the existing cursor and queued data are retained.');
  return stat.dev.toString()+':'+stat.ino.toString();
}
export const validTranscriptIdentity=(value:unknown):value is string=>typeof value==='string'&&/^(?:0|[1-9]\d*):[1-9]\d*$/.test(value);
/** A numeric legacy inode has no device binding, even when it is a safe integer. */
export function transcriptIdentityMatches(saved:unknown,current:string):boolean {
  if(!validTranscriptIdentity(saved))
    throw new CliError('CAPTURE_FILE_IDENTITY_UNVERIFIED','This transcript has no verifiable saved file identity. Capture is paused; its cursor and queued data are unchanged. Run setup resume with this same CLI profile and API to refresh only unverifiable future-recording boundaries; saved history choices stay unchanged.');
  return saved===current;
}
