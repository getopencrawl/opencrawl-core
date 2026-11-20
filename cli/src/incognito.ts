import {mkdirSync,renameSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {readSearchContextEvent} from './search-context.ts';
import {parseArgs} from 'node:util';
import {atomicJson,configDir,syncDirectory,withSessionLock} from './session.ts';
import {recoverLiveSeals} from './capture/live-batches.ts';
import {boardRequest} from './board.ts';
import {captureDir,readCaptureConfig,type CaptureConfig} from './capture/runtime.ts';
import {privacyKey,privacyRoot,sessionPrivate,pendingPrivacy,type PrivateSession} from './incognito-state.ts';
import {checkEvent,nativeId,object} from './context-check-events.ts';

import {privatePrompt,privateSkill} from '../../src/sessions/private-invocation.mts';

const clients=['codex','claude-code','cursor','antigravity','devin'];

export function nativePrivacySession(harness:string,event:unknown):PrivateSession|undefined {
  if(!object(event)||!clients.includes(harness)||harness!=='cursor'&&event.cursor_version!==undefined)return;
  const id=harness==='antigravity'?event.conversationId:harness==='cursor'?event.conversation_id??event.session_id:event.session_id;
  if(!nativeId(id))return;
  const child=event.agent_id;
  if(child==null)return {harness,sessionId:id};
  if(!nativeId(child)||!['codex','claude-code'].includes(harness))return;
  const sessionId=harness==='codex'?child:id+':'+child;
  if(nativeId(sessionId))return {harness,sessionId};
}

export function invokesPrivacy(harness:string,event:unknown,config?:CaptureConfig){
  if(!object(event))return false;
  if(harness==='claude-code'&&event.hook_event_name==='PreToolUse'&&event.tool_name==='Skill'&&object(event.tool_input))
    return typeof event.tool_input.skill==='string'&&privateSkill(event.tool_input.skill,config?.api);
  const name=harness==='antigravity'?event.hookEventName:event.hook_event_name;
  if(name!==(harness==='antigravity'?'PreInvocation':harness==='cursor'?'beforeSubmitPrompt':'UserPromptSubmit'))return false;
  const prompt=harness==='antigravity'?event.lastUserInput:event.prompt;
  if(typeof prompt!=='string'||!privatePrompt(prompt,config?.api))return false;
  return harness!=='antigravity'||Boolean(config&&checkEvent('antigravity',event,config)?.message);
}

export function markPrivate(config:CaptureConfig,session:PrivateSession){
  if(config.authPending||!config.owner?.tenantId||!config.owner.userId)throw Error('A bound OpenCrawl profile is required');
  if(!sessionPrivate(config,session))atomicJson(join(privacyRoot(config),'pending',privacyKey(session)),session);
}

// All candidates are OpenCrawl-owned files. No path from their contents is unlinked.
function spoolFiles(dir:string){
  try{return readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile()&&/\.json(?:\.held)?$/.test(e.name)).map(e=>e.name);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
}

function spoolRecord(path:string){
  try{return JSON.parse(readFileSync(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
}

export async function purgePrivateQueue(config:CaptureConfig,session:PrivateSession){
  const dir=captureDir(),matches=(s:PrivateSession|undefined)=>s?.harness===session.harness&&s.sessionId===session.sessionId;
  const owned=(owner:CaptureConfig['owner']|undefined)=>owner?.userId===config.owner.userId&&owner?.tenantId===config.owner.tenantId;
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
  await withSessionLock('capture:notices',()=>withSessionLock('capture:spool',()=>withSessionLock('capture:flush',async()=>{
    const current=readCaptureConfig();
    if(!current||privacyRoot(current)!==privacyRoot(config)||!sessionPrivate(config,session))throw Error('Privacy profile changed');
    recoverLiveSeals(dir);
    // A standalone plugin and the CLI may race to acknowledge the same intent.
    // Either participant must clean the plugin's session-local capture receipts.
    const owner={tenantId:config.owner.tenantId,userId:config.owner.userId};
    const plugin=join(configDir(),'plugin-state',hash(JSON.stringify([config.api,config.installationId,owner,session.harness])));
    const sessionHash=hash(session.sessionId);
    for(const path of [join(plugin,'observed',sessionHash),join(plugin,'cursor-notices',sessionHash),join(plugin,sessionHash+'.json')]){
      rmSync(path,{recursive:true,force:true});
    }
    const suggestions=join(plugin,'suggestions'),suggestionId=hash(JSON.stringify([session.harness,session.sessionId]));
    rmSync(join(suggestions,'latest',suggestionId+'.json'),{force:true});
    for(const file of spoolFiles(join(suggestions,'tasks'))){
      const path=join(suggestions,'tasks',file);
      if(spoolRecord(path)?.session===suggestionId)rmSync(path,{force:true});
    }
    const erasedBlobs=new Set<string>(),remainingBlobs=new Set<string>();
    for(const name of spoolFiles(join(dir,'queue'))){
      const file=join(dir,'queue',name),batch=spoolRecord(file);
      if(!batch)continue;
      const erase=matches(batch)&&owned(batch.owner);
      for(const a of batch.attachments??[])if(/^[a-f0-9]{64}$/.test(a.sha256??''))(erase?erasedBlobs:remainingBlobs).add(a.sha256);
      if(erase)for(const part of ['queue','rejected','live'])rmSync(join(dir,part,name),{force:true});
    }
    for(const digest of erasedBlobs)if(!remainingBlobs.has(digest))rmSync(join(dir,'blobs',digest),{force:true});
    for(const part of ['notices','sources','state','daemon/inbox','daemon/sessions']){
      const directory=join(dir,part);
      for(const name of spoolFiles(directory)){
        const path=join(directory,name),r=spoolRecord(path);
        if(!r||r.owner&&!owned(r.owner)||r.api&&r.api!==config.api)continue;
        const notice=r.record??r;
        const identity=object(notice.event)?nativePrivacySession(notice.harness,notice.event):r.meta??r;
        if(matches(identity)||part==='state'&&session.harness==='cursor'&&name==='cursor-'+hash(session.sessionId)+'.json')rmSync(path,{force:true});
      }
    }
  },5000),5000),5000);
}

export async function submitPrivacy(config:CaptureConfig,session:PrivateSession,refresh=true){
  const validateBinding=()=>{
    const current=readCaptureConfig();
    if(!current||current.authPending||privacyRoot(current)!==privacyRoot(config))throw Error('Privacy profile changed');
  };
  const [remote,local]=await Promise.allSettled([boardRequest(config.api,'incognito',{currentSession:session,workspace:config.owner.tenantId},fetch,{expectedOwner:config.owner,validateBinding,refresh}),purgePrivateQueue(config,session)]);
  if(local.status==='rejected')throw local.reason;
  if(remote.status==='rejected')throw remote.reason;
  const result=remote.value;
  if(result.boardBlocked!==true||result.session?.harness!==session.harness||result.session?.sessionId!==session.sessionId||
      !(result.pending===true&&result.deleted===false||result.pending===false&&result.deleted===true))throw Error('Invalid incognito receipt');
  const root=privacyRoot(config),key=privacyKey(session);
  mkdirSync(join(root,'accepted'),{recursive:true,mode:0o700});
  try{renameSync(join(root,'pending',key),join(root,'accepted',key));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  syncDirectory(join(root,'accepted'));
  return result;
}

export async function retryPrivacy(config:CaptureConfig){
  for(const session of pendingPrivacy(config))await submitPrivacy(config,session);
}

export function privateHookSession(harness:string,event:unknown,config=readCaptureConfig()){
  if(!config)return;
  const session=nativePrivacySession(harness,event);
  if(!session)return;
  if(invokesPrivacy(harness,event,config))markPrivate(config,session);
  return sessionPrivate(config,session)?session:undefined;
}

export function denyBoardSend(harness:string,event:unknown){
  if(!object(event))return;
  const tool=object(event.toolCall)?event.toolCall:undefined;
  const name=String(tool?.name??event.tool_name??'');
  if(!/(?:^|_|:)board_(?:post|publish|presence|follow)$/.test(name)&&!(name==='call_mcp_tool'&&object(tool?.args)&&/^board_(?:post|publish|presence|follow)$/.test(String(tool.args.ToolName))))return;
  const reason='This session is incognito and cannot send board messages.';
  if(harness==='cursor')return {permission:'deny',agent_message:reason};
  if(harness==='antigravity')return {decision:'deny',reason};
  return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}};
}

export async function privacyHook(args:string[]){
  const {values}=parseArgs({args,options:{harness:{type:'string'},api:{type:'string'}}});
  const config=readCaptureConfig(),harness=values.harness;
  if(!harness||!config||config.api!==values.api)return 0;
  const event=await readSearchContextEvent(process.stdin,1000,8*1024*1024);
  const session=privateHookSession(harness,event,config);
  if(!session)return 0;
  // The marker survives timeouts and the worker retries with bound credentials.
  if(invokesPrivacy(harness,event,config)){
    try{await submitPrivacy(config,session,false);}catch{process.stderr.write('Incognito active locally. Remote erasure is pending.\n');}
  }
  return 0;
}

export async function privacyCommand(args:string[]){
  const {values}=parseArgs({args,options:{harness:{type:'string'},session:{type:'string'},api:{type:'string'}}});
  const config=readCaptureConfig(),harness=values.harness,sessionId=values.session;
  if(!config||values.api!==config.api||!harness||!clients.includes(harness)||!nativeId(sessionId))throw Error('Supply the enrolled --api, --harness and current native --session');
  const session={harness,sessionId};
  markPrivate(config,session);
  try{const receipt=await submitPrivacy(config,session);process.stdout.write(JSON.stringify(receipt)+'\n');return 0;}
  catch{process.stderr.write('Incognito is active locally. Remote erasure is pending. Retry this command when connected.\n');return 1;}
}
