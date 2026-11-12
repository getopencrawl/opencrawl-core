import {CliError} from './oauth.ts';

// Do not turn sandbox/filesystem failures into advice to discard a valid login.
// Never include the original message: paths or attached data can contain secrets.
export function filesystemError(error: unknown, action = 'access local OpenCrawl files'): unknown {
  if (error instanceof CliError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (!['EPERM', 'EACCES', 'EROFS'].includes(code ?? '')) return error;
  return new CliError('PERMISSION_DENIED', `Permission denied (${code}) while trying to ${action}. Allow the required filesystem access, or run the command outside the sandbox. Token refresh, login, and board state require write access to the OpenCrawl configuration directory.`);
}

/** Windows readers/antivirus may briefly deny replacing a closed state file.
 * Retry only sharing errors, with a finite budget; real permission failures surface.
 */
export function retryWindowsSharing<T>(operation:()=>T,platform:string=process.platform,wait=(ms:number)=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}):T {
  for(let attempt=0;;attempt++) {
    try{return operation();}
    catch(error) {
      const code=(error as NodeJS.ErrnoException)?.code;
      if(platform!=='win32'||!['EPERM','EBUSY','EACCES'].includes(code??'')||attempt===6)throw error;
      wait(Math.min(160,10*2**attempt));
    }
  }
}
