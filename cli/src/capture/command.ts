import {CliError} from '../oauth.ts';
import {installCapture,uninstallCapture} from './install.ts';
import {captureHook,captureStatus,syncCaptures,flushCaptures,recordError} from './runtime.ts';
export async function collectCommand(action:string,api:string,values:any) {
  switch(action) {
    case 'install': return installCapture(api,{background:!values['no-background']&&process.env.CLAUDE_CODE_REMOTE!=='true',...(values.harness?{harnesses:[values.harness]}:{})});
    case 'uninstall': return uninstallCapture();
    case 'status': return captureStatus();
    case 'sync': try{return await syncCaptures();}catch(e){recordError(e);throw e;}
    case 'flush': try{return await flushCaptures();}catch(e){recordError(e);throw e;}
    case 'hook': {
      // Hooks must never block or add output to the user's agent conversation.
      try {
        if(!['claude-code','codex'].includes(values.harness))throw new Error('Invalid harness');
        let size=0;const chunks:Buffer[]=[];
        for await(const chunk of process.stdin){size+=chunk.length;if(size>48*1024*1024)throw new Error('Hook too large');chunks.push(Buffer.from(chunk));}
        await captureHook(values.harness,JSON.parse(Buffer.concat(chunks).toString()));
      }catch(e){try{recordError(e);}catch{}}
      return null;
    }
    default: throw new CliError('INVALID_USAGE','Use collect install, status, sync, flush, or uninstall.',64);
  }
}
