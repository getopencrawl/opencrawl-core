import {CliError} from '../oauth.ts';
import {installCapture,uninstallCapture,upgradeCaptureHooks} from './install.ts';
import {captureHook,captureAttentionNotice,ownedCaptureWorker,captureStatus,syncCaptures,flushCaptureWork,refreshCapturedTitles,recordError,hookFlush,bindHookIdentity} from './runtime.ts';
import {credentialRotation} from '../session.ts';
import {grokBotResponse} from './grok-bot.ts';
import {backfill,backfillPreview,selection,setupBackfill} from './backfill.ts';
import {approveCapture,excludeCapture,purgeLocalCapture} from './controls.ts';
import {captureNoticeFor} from './policy.ts';
import {agentSkills} from '../skills.ts';
/** With eager set, return as soon as a whole document has arrived: a runtime
 * may keep the pipe open after writing the payload. */
async function hookInput(eager=false) {
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of process.stdin){
    size+=chunk.length;if(size>48*1024*1024)throw new Error('Hook too large');chunks.push(Buffer.from(chunk));
    // Only a chunk ending in a closing brace can complete a JSON object.
    if(eager&&/\}\s*$/.test(chunk.subarray(-16).toString('latin1'))){try{return JSON.parse(Buffer.concat(chunks).toString());}catch{}}
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
/** Grok Bot waits for this process on every hook. Answer as soon as the payload
 * is read, then record and take at most one upload pass. Nothing here may deny
 * or long delay an action. An outer deadline cannot interrupt a held lock or a
 * request in flight, so the process ends at five seconds, well inside the
 * installed hook timeout. The one thing it waits for is a sign-in renewal
 * already in flight: abandoning that would lose the sign-in. */
async function grokBotHook() {
  let answered=false;
  const answer=(event:any)=>{if(!answered){answered=true;process.stdout.write(JSON.stringify(grokBotResponse(event))+'\n');}};
  const finish=()=>{const renewing=credentialRotation();if(renewing)void renewing.finally(()=>process.exit(0));else process.exit(0);};
  const deadline=setTimeout(()=>{
    answer(null);
    try{recordError(new CliError('CAPTURE_HOOK_DEADLINE','A capture hook reached its five-second limit. Queued data is retained; run opencrawl collect flush.'));}catch{}
    finish();
  },5000);
  try {
    const event=await hookInput(true);
    answer(event);
    await bindHookIdentity(event);
    await captureHook('grok-bot',event);
    await upgradeCaptureHooks();
    await hookFlush(event);
  }catch(e){answer(null);try{recordError(e);}catch{}}
  clearTimeout(deadline);
  // The pipe may still be open, which would keep this process alive.
  await new Promise<void>(resolve=>process.stdout.write('',()=>resolve()));
  finish();
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
        // Cursor-format runtimes, Grok Bot included, also load Claude Code hook
        // files and wait on every hook. That is not a Claude Code or Codex
        // session: record nothing and never start the uploader there.
        if(typeof event?.cursor_version==='string')return null;
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
