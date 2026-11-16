import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {backfill,type HistoryFile} from '../capture/backfill.ts';
import {readCaptureConfig,commandForSelf} from '../capture/runtime.ts';
import {withSessionLock} from '../session.ts';
import {CliError} from '../oauth.ts';
import {chosen,readStateKey,readSetupState,scopeKey,updateSetupState,type SetupState,type HistoryJob} from './state.ts';
import {publishSetup} from './api.ts';

export function historyJob(previous:SetupState|null,clients:string[],files:HistoryFile[]):HistoryJob|undefined {
  if(!clients.length)return undefined;
  const previousJob=previous?.historyJob;
  if(previousJob&&JSON.stringify(previousJob.clients)===JSON.stringify(clients)&&JSON.stringify(previousJob.files)===JSON.stringify(files)&&previousJob.state!=='paused')return previousJob;
  const now=new Date().toISOString();return {id:randomUUID(),clients,files,state:'queued',completedClients:[],createdAt:now,updatedAt:now};
}
export function startHistoryWorker(state:SetupState,launch=spawn):{state:string;jobId?:string}{
  const job=state.historyJob;
  if(!job||job.state==='complete'||job.state==='paused')return {state:job?.state??'not_started',...(job?{jobId:job.id}:{})};
  if(job.state==='running'&&Date.now()-Date.parse(job.updatedAt)<60000)return {state:'running',jobId:job.id};
  const command=commandForSelf(),child=launch(command[0],command.slice(1).concat(['setup','worker','--scope-key',scopeKey(state.scope),'--api',state.scope.api]),{stdio:'ignore',detached:true,shell:false,env:{...process.env,OPENCRAWL_NO_UPDATE:'1'}});
  child.on('error',()=>{void updateSetupState(state.scope,current=>current?.historyJob?.id===job.id?{...current,historyJob:{...current.historyJob,state:'failed',error:'HISTORY_WORKER_START_FAILED',updatedAt:new Date().toISOString()}}:current??state).catch(()=>{});});child.unref();return {state:'queued',jobId:job.id};
}
function assertDestination(state:SetupState){
  const config=readCaptureConfig();
  if(!config||config.disabled||config.authPending||config.api!==state.scope.api||config.owner.tenantId!==state.scope.tenantId||config.owner.userId!==state.scope.userId||config.installationId!==state.installationId)throw new CliError('SETUP_SCOPE_CHANGED','History is paused because the signed-in capture destination changed.');
}
export async function runHistoryWorker(key:string,{importHistory=backfill,publish=publishSetup,publishEveryMs=5000}:{importHistory?:typeof backfill;publish?:typeof publishSetup;publishEveryMs?:number}={}){
  const initial=readStateKey(key);if(!initial?.historyJob)return;
  try{return await withSessionLock('setup:history:'+key,async()=>{
    const state=readStateKey(key);if(!state?.historyJob||['complete','paused'].includes(state.historyJob.state))return;
    const id=state.historyJob.id;
    const update=async(change:(job:HistoryJob)=>HistoryJob)=>updateSetupState(state.scope,current=>{if(!current?.historyJob||current.historyJob.id!==id)throw new CliError('SETUP_HISTORY_PAUSED','History choices changed; the previous import stopped.');return {...current,historyJob:change(current.historyJob)};});
    let observationFailure:unknown,observing:Promise<void>|undefined,lastObservation=Date.now();
    const permitted=(client?:string)=>{if(observationFailure)throw observationFailure;const current=readStateKey(key);if(!current?.historyJob||current.historyJob.id!==id||client&&!chosen(current.selections,'history').includes(client))throw new CliError('SETUP_HISTORY_PAUSED','History choices changed; the previous import stopped.');assertDestination(current);};
    const observe=async(value:SetupState)=>{try{await publish(value);}catch(error){if(error instanceof CliError&&['SETUP_SCOPE_CHANGED','AUTH_REQUIRED','SETUP_FORBIDDEN'].includes(error.code))throw error;}};
    let progressWrites=Promise.resolve();
    try{
      permitted();let current=await update(job=>({...job,state:'running',pid:process.pid,error:undefined,updatedAt:new Date().toISOString()}));await observe(current);
      for(const client of current.historyJob!.clients){
        if(current.historyJob!.completedClients.includes(client))continue;
        permitted(client);
        await importHistory(state.scope.api,client as HistoryFile['harness'],true,{files:current.historyJob!.files.filter(file=>file.harness===client),beforeFile:()=>permitted(client),onProgress:progress=>{
          progressWrites=progressWrites.then(async()=>{const next=await update(job=>({...job,updatedAt:new Date().toISOString(),progress:{client,completed:progress.processed,total:progress.totalFiles,uploaded:progress.uploaded}}));
            if(!observing&&Date.now()-lastObservation>=publishEveryMs){lastObservation=Date.now();observing=observe(next).catch(error=>{observationFailure=error;}).finally(()=>{observing=undefined;});}
          });
          void progressWrites.catch(()=>{});
        }});
        await progressWrites;await observing;permitted(client);
        current=await update(job=>({...job,completedClients:[...new Set([...job.completedClients,client])],updatedAt:new Date().toISOString()}));await observe(current);
      }
      current=await update(job=>({...job,state:'complete',pid:undefined,updatedAt:new Date().toISOString()}));await observe(current);
    }catch(error){
      await progressWrites.catch(()=>{});await observing;
      const code=error instanceof CliError?error.code:'HISTORY_IMPORT_FAILED';
      const current=await update(job=>({...job,state:['SETUP_HISTORY_PAUSED','SETUP_SCOPE_CHANGED','CAPTURE_DESTINATION_CHANGED','AUTH_REQUIRED','SETUP_FORBIDDEN'].includes(code)?'paused':'failed',error:code,pid:undefined,updatedAt:new Date().toISOString()})).catch(()=>null);
      if(current)await publish(current).catch(()=>{});
    }
  },0);}catch(error){if(!(error instanceof CliError)||error.code!=='SESSION_BUSY')throw error;}
}
/** Reopening an enrolled CLI can resume only an already approved, matching job. */
export function wakeApprovedHistory(){const config=readCaptureConfig();if(!config||config.disabled||config.authPending)return;const state=readSetupState({api:config.api,tenantId:config.owner.tenantId,userId:config.owner.userId});if(state&&state.installationId===config.installationId)startHistoryWorker(state);}
