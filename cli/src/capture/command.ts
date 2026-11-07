import {CliError} from '../oauth.ts';
import {installCapture,uninstallCapture,upgradeCaptureHooks} from './install.ts';
import {captureHook,ownedCaptureWorker,captureStatus,syncCaptures,flushCaptureWork,recordError} from './runtime.ts';
import {backfill,backfillPreview,selection,setupBackfill} from './backfill.ts';
import {approveCapture,excludeCapture,purgeLocalCapture} from './controls.ts';
import {captureNotice} from './policy.ts';
export async function collectCommand(action:string,api:string,values:any) {
  if((values.backfill!==undefined || values['defer-auth']) && action!=='install' || values['dry-run'] && action!=='backfill' || values.yes && !['backfill','install','purge'].includes(action))throw new CliError('INVALID_USAGE','Use --backfill with install; --dry-run with backfill; --yes with install, backfill or purge.',64);
  if(values.project!==undefined && action!=='exclude' || values['session-id']!==undefined && action!=='exclude')throw new CliError('INVALID_USAGE','Use --project or --session-id with collect exclude.',64);
  switch(action) {
    case 'install': {
      const mode=values.backfill??(process.env.CLAUDE_CODE_REMOTE==='true'?'skip':'ask');
      if(!['ask','skip','all','claude-code','codex'].includes(mode))throw new CliError('INVALID_USAGE','Use --backfill ask, skip, all, claude-code, or codex.',64);
      if(!await approveCapture(values.yes===true,values.json))return {status:'consent_required',notice:captureNotice,nextStep:'Confirm the destination and recording scope with the user, then run collect install --yes. This does not approve history import.'};
      const installed=await installCapture(api,{deferAuth:values['defer-auth']===true,...(values.harness?{harnesses:[values.harness]}:{})});
      return {...installed,backfill:await setupBackfill(api,mode,values.json)};
    }
    case 'backfill': {
      const selected=selection(values.harness);
      if(values['dry-run'] && values.yes)throw new CliError('INVALID_USAGE','Use either --dry-run or --yes, not both.',64);
      try{
        if(!values['dry-run'] && !values.yes && values.harness===undefined)return await setupBackfill(api,'ask',values.json);
        return values['dry-run']?backfillPreview(api,selected):await backfill(api,selected,values.yes===true);
      }
      catch(e){if(values.yes)recordError(e);throw e;}
    }
    case 'exclude': return excludeCapture(values.project,values['session-id']);
    case 'purge': return purgeLocalCapture(values.yes===true);
    case 'uninstall': return uninstallCapture();
    case 'status': return captureStatus();
    case 'sync': try{return await syncCaptures();}catch(e){recordError(e);throw e;}
    case 'flush': try{return await flushCaptureWork();}catch(e){recordError(e);throw e;}
    case 'worker': {try{await ownedCaptureWorker();}catch(e){try{recordError(e);}catch{}}return null;}
    case 'hook': {
      // Only harness-managed async hooks may upload. Legacy sync hooks stay local.
      try {
        if(!['claude-code','codex'].includes(values.harness))throw new Error('Invalid harness');
        let size=0;const chunks:Buffer[]=[];
        for await(const chunk of process.stdin){size+=chunk.length;if(size>48*1024*1024)throw new Error('Hook too large');chunks.push(Buffer.from(chunk));}
        await captureHook(values.harness,JSON.parse(Buffer.concat(chunks).toString()));
        await upgradeCaptureHooks();
        if(values.managed)await ownedCaptureWorker();
      }catch(e){try{recordError(e);}catch{}}
      return null;
    }
    default: throw new CliError('INVALID_USAGE','Use collect install, backfill, status, sync, flush, exclude, uninstall, or purge.',64);
  }
}
