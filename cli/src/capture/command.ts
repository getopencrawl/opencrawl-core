import {CliError} from '../oauth.ts';
import {installCapture,uninstallCapture,upgradeCaptureHooks} from './install.ts';
import {captureHook,captureAttentionNotice,ownedCaptureWorker,captureStatus,syncCaptures,flushCaptureWork,refreshCapturedTitles,recordError,hookFlush} from './runtime.ts';
import {grokBotResponse} from './grok-bot.ts';
import {backfill,backfillPreview,selection,setupBackfill} from './backfill.ts';
import {approveCapture,excludeCapture,purgeLocalCapture} from './controls.ts';
import {captureNoticeFor} from './policy.ts';
import {agentSkills} from '../skills.ts';
async function hookInput() {
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of process.stdin){size+=chunk.length;if(size>48*1024*1024)throw new Error('Hook too large');chunks.push(Buffer.from(chunk));}
  return JSON.parse(Buffer.concat(chunks).toString());
}
/** Grok Bot waits for this process on every hook. Answer first, then record and
 * take at most one upload pass. Nothing here may deny or long delay an action:
 * an outer deadline cannot interrupt a held lock or a request in flight, so the
 * process ends at five seconds, inside the installed ten-second hook timeout. */
async function grokBotHook() {
  let event:any=null,invalid:unknown;
  try{event=await hookInput();}catch(error){invalid=error;}
  process.stdout.write(JSON.stringify(grokBotResponse(event))+'\n');
  const deadline=setTimeout(()=>process.exit(0),5000);
  try {
    if(invalid)throw invalid;
    await captureHook('grok-bot',event);
    await upgradeCaptureHooks();
    await hookFlush(event);
  }catch(e){try{recordError(e);}catch{}}
  finally{clearTimeout(deadline);}
  return null;
}
export async function collectCommand(action:string,api:string,values:any) {
  if((values.backfill!==undefined || values['defer-auth']) && action!=='install' || values['dry-run'] && action!=='backfill' || values.yes && !['backfill','install','purge'].includes(action))throw new CliError('INVALID_USAGE','Use --backfill with install; --dry-run with backfill; --yes with install, backfill or purge.',64);
  if(values.project!==undefined && action!=='exclude' || values['session-id']!==undefined && action!=='exclude')throw new CliError('INVALID_USAGE','Use --project or --session-id with collect exclude.',64);
  switch(action) {
    case 'install': {
      // Grok Bot keeps no local history to import.
      const mode=values.backfill??(process.env.CLAUDE_CODE_REMOTE==='true'||values.harness==='grok-bot'?'skip':'ask');
      if(!['ask','skip','all','claude-code','codex'].includes(mode))throw new CliError('INVALID_USAGE','Use --backfill ask, skip, all, claude-code, or codex.',64);
      const notice=captureNoticeFor(values.harness);
      if(!await approveCapture(values.yes===true,values.json,notice))return {status:'consent_required',notice,nextStep:'Confirm the destination and recording scope with the user, then run collect install --yes. This does not approve history import.'};
      const installed=await installCapture(api,{deferAuth:values['defer-auth']===true,...(values.harness?{harnesses:[values.harness]}:{})});
      // Skill setup must not undo working capture or hide its installed state.
      const skills=await agentSkills('install',api).catch(()=>({status:'error',nextStep:`Capture is installed. Run opencrawl skills install --api ${api} with approved access to agent skill directories.`}));
      return {...installed,skills,backfill:await setupBackfill(api,mode,values.json)};
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
    case 'titles': try{return await refreshCapturedTitles();}catch(e){recordError(e);throw e;}
    case 'flush': try{return await flushCaptureWork();}catch(e){recordError(e);throw e;}
    case 'worker': {try{await ownedCaptureWorker();}catch(e){try{recordError(e);}catch{}}return null;}
    case 'hook': {
      if(values.harness==='grok-bot')return grokBotHook();
      // Only harness-managed async hooks may upload. Legacy sync hooks stay local.
      try {
        if(!['claude-code','codex'].includes(values.harness))throw new Error('Invalid harness');
        const event=await hookInput();
        await captureHook(values.harness,event);
        // Async Claude Code hooks deliver this JSON on the next turn, so a
        // paused capture is visible to the person instead of failing silently.
        const notice=values.harness==='claude-code'&&['SessionStart','UserPromptSubmit'].includes(event?.hook_event_name)?captureAttentionNotice():null;
        if(notice)process.stdout.write(JSON.stringify({systemMessage:notice,hookSpecificOutput:{hookEventName:event.hook_event_name,additionalContext:notice}})+'\n');
        await upgradeCaptureHooks();
        if(values.managed)await ownedCaptureWorker();
      }catch(e){try{recordError(e);}catch{}}
      return null;
    }
    default: throw new CliError('INVALID_USAGE','Use collect install, backfill, status, sync, titles, flush, exclude, uninstall, or purge.',64);
  }
}
