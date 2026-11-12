import {readdirSync, statSync, realpathSync} from 'node:fs';
import {join, sep} from 'node:path';
import {homedir} from 'node:os';
import {atomicJson} from '../session.ts';
import {createInterface} from 'node:readline/promises';
import {CliError} from '../oauth.ts';
import {setTimeout as pause} from 'node:timers/promises';
import {captureTranscript, captureDir, flushCaptures, readCaptureConfig, refreshCaptureIdentity, recordError, type CaptureConfig} from './runtime.ts';
import type {TranscriptHarness} from './parse.ts';
import {claudeDesktopHistories,defaultClaudeDesktopSessionsRoot} from './desktop-history.ts';

export const backfillNotice = 'Import local Claude Code and Codex history, including desktop coding sessions and host-mirrored Claude Desktop transcripts. Messages, tool arguments/results and available attachments will be shared with your signed-in OpenCrawl team and attributed to you. Cloud-only chats and VM-only records are not included.';
type Selection = 'all'|TranscriptHarness;
export function selection(value = 'all'): Selection {
  if (!['all','claude-code','codex'].includes(value)) throw new CliError('INVALID_USAGE','Choose all, claude-code, or codex.',64);
  return value as Selection;
}
function configFor(api:string) {
  const config=readCaptureConfig();
  if(!config || config.disabled)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install first.');
  if(config.api!==api)throw new CliError('CAPTURE_API_MISMATCH','Use the installed collector’s --api URL, or run collect install with the new URL first.');
  return config;
}
/** File metadata only: preview never reads transcript contents, spools data, or contacts the server. */
export function inventory(config:Pick<CaptureConfig,'roots'|'claudeDesktopSessionsRoot'>, selected:Selection) {
  const files:{harness:TranscriptHarness,path:string,bytes:number}[]=[];
  const sources:{harness:TranscriptHarness,files:number,bytes:number}[]=[];
  for(const harness of ['claude-code','codex'] as TranscriptHarness[]) {
    if(selected!=='all' && selected!==harness)continue;
    const source={harness,files:0,bytes:0};sources.push(source);
    let root:string|undefined;
    try{root=realpathSync(config.roots[harness]);}catch(e:any){if(e.code!=='ENOENT')throw new CliError('BACKFILL_SCAN_FAILED','Cannot inspect a local session directory. Check its permissions.');}
    const seen=new Set<string>();
    function visit(dir:string,allowedRoot:string) {
      let entries;
      try{entries=readdirSync(dir,{withFileTypes:true});}catch(e:any){if(e.code==='ENOENT')return;throw new CliError('BACKFILL_SCAN_FAILED','Cannot inspect a local session directory. Check its permissions.');}
      for(const entry of entries) {
        const path=join(dir,entry.name);
        // Never follow symlinks out of the native transcript store.
        if(entry.isSymbolicLink())continue;
        if(entry.isDirectory())visit(path,allowedRoot);
        else if(entry.isFile() && (path.endsWith('.jsonl') || harness==='codex' && path.endsWith('.jsonl.zst'))) {
          const real=realpathSync(path);
          if(!real.startsWith(allowedRoot+sep))throw new CliError('CAPTURE_PATH_REJECTED','Session path changed during discovery. Retry the preview.');
          if(seen.has(real))continue;seen.add(real);
          const bytes=statSync(real).size;
          files.push({harness,path:real,bytes});source.files++;source.bytes+=bytes;
        }
      }
    }
    if(root)for(const dir of harness==='codex'?['sessions','archived_sessions']:['projects'])visit(join(root,dir),root);
    if(harness==='claude-code') {
      const desktop=claudeDesktopHistories(config);
      for(const projects of desktop.projects)visit(projects,realpathSync(projects));
      for(const path of desktop.audits) {
        const real=realpathSync(path);if(seen.has(real))continue;seen.add(real);
        const bytes=statSync(real).size;files.push({harness,path:real,bytes});source.files++;source.bytes+=bytes;
      }
    }
  }
  return {files,sources};
}
export function backfillPreview(api:string, selected:Selection='all') {
  const config=readCaptureConfig();
  if(config&&config.api!==api)throw new CliError('CAPTURE_API_MISMATCH','Use the installed collector’s --api URL, or run collect install with the new URL first.');
  // Metadata discovery is useful before consent and must not install hooks,
  // create capture state, authenticate, or read transcript contents.
  const roots=config??{roots:{'claude-code':process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'),codex:process.env.CODEX_HOME||join(homedir(),'.codex')},claudeDesktopSessionsRoot:defaultClaudeDesktopSessionsRoot()};
  const {sources}=inventory(roots,selected);
  return {status:'preview',api,owner:config?.authPending?null:config?.owner??null,sources,notice:backfillNotice,
    nextStep:'Ask the user whether to import Claude, Codex, both, or skip. Only after they choose, run opencrawl collect backfill --harness <claude-code|codex|all> --yes --api '+api+'. Install capture with the approved recording scope before importing. To skip during setup, use collect install --backfill skip.'};
}
// Retry transient auth and transport failures without discarding credentials or
// cursors. Terminal authorization/scope errors must fail immediately.
const transient=(e:unknown)=>!(e instanceof CliError)||['NETWORK_ERROR','AUTH_UNAVAILABLE','SESSION_BUSY','CAPTURE_RETRY_EXHAUSTED'].includes(e.code)||e.code==='CAPTURE_UPLOAD_FAILED'&&/\((429|5\d\d)\)/.test(e.message);
export type BackfillProgress={status:'importing'|'retrying'|'complete'|'failed';processed:number;totalFiles:number;processedBytes:number;totalBytes:number;uploaded:number;retryInMs?:number};
export const reportBackfillProgress=(json=false)=>(progress:BackfillProgress)=>process.stderr.write(json
  ?JSON.stringify({schemaVersion:1,type:'backfill.progress',...progress})+'\n'
  :`History ${progress.status}: ${progress.processed}/${progress.totalFiles} files, ${progress.processedBytes}/${progress.totalBytes} source bytes, ${progress.uploaded} batches uploaded${progress.retryInMs===undefined?'':`; retry in ${Math.ceil(progress.retryInMs/1000)}s`}.\n`);
export async function backfill(api:string, selected:Selection, approved:boolean, options:{retryDelays?:number[];concurrency?:number;batchDelayMs?:number;onProgress?:(progress:BackfillProgress)=>void}={}) {
  const concurrency=options.concurrency??4,batchDelayMs=options.batchDelayMs??0;
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4||!Number.isInteger(batchDelayMs)||batchDelayMs<0||batchDelayMs>60000)throw new CliError('INVALID_USAGE','Use --concurrency 1..4 and --batch-delay-ms 0..60000.',64);
  const delays=options.retryDelays??[2000,5000,15000,30000,60000];
  if(!approved)throw new CliError('BACKFILL_CONSENT_REQUIRED','Preview with collect backfill --dry-run. Ask the user to choose Claude, Codex, both, or skip; pass --yes only after approval.',64);
  const config=configFor(api),{files,sources}=inventory(config,selected);
  let processed=0,processedBytes=0,uploaded=0,lastProgress=0;
  const totalBytes=sources.reduce((sum,source)=>sum+source.bytes,0);
  const progress=(status:BackfillProgress['status']='importing',force=false,retryInMs?:number)=>{
    if(!force&&Date.now()-lastProgress<1000)return;
    lastProgress=Date.now();
    const value={status,processed,totalFiles:files.length,processedBytes,totalBytes,uploaded,...(retryInMs===undefined?{}:{retryInMs})};
    atomicJson(join(captureDir(),'backfill-progress.json'),{...value,updatedAt:new Date().toISOString()});
    options.onProgress?.(value);
  };
  const retry=async<T>(run:()=>Promise<T>):Promise<T>=>{
    for(let attempt=0;;attempt++) {
      try{return await run();}
      catch(error) {
        if(attempt>=delays.length||!transient(error))throw error;
        const delay=Math.max(delays[attempt],error instanceof CliError?error.retryAfterMs??0:0);
        progress('retrying',true,delay);await pause(delay);
      }
    }
  };
  const flush=()=>retry(()=>flushCaptures({concurrency,batchDelayMs,onUploaded:()=>{uploaded++;progress();}}));
  const pending=()=>readdirSync(join(captureDir(),'queue')).some(name=>name.endsWith('.json'));
  const failures:{code:string}[]=[];
  progress('importing',true);
  try {
    await retry(()=>refreshCaptureIdentity(config));
    for(const file of files) {
      try{await captureTranscript(config,file.harness,file.path,{},true);processed++;processedBytes+=file.bytes;}
      catch(e){failures.push({code:e instanceof CliError?e.code:'CAPTURE_FAILED'});recordError(e);}
      // Bound the spool to one transcript. Within it, four uploads share one
      // exclusive flush owner and retain every batch until its durable receipt.
      if(pending())await flush();
      progress();
    }
    if(pending())await flush();
    if(failures.length)throw new CliError('BACKFILL_INCOMPLETE',`Imported ${processed} of ${files.length} transcript files; ${failures.length} failed (${failures[0].code}). Fix the reported error and rerun the approved import; saved cursors prevent reimporting completed records.`);
    progress('complete',true);
    return {status:'complete',sources,processed,processedBytes,uploaded,notice:'Uploaded counts batches, not sessions. Source bytes count local files (compressed when archived), not network bytes. Already captured records are skipped. Only locally available records can be imported.'};
  }catch(error){progress('failed',true);recordError(error);throw error;}
}
export async function chooseBackfill(ask:(prompt:string)=>Promise<string>) {
  const answer=(await ask('Import history? [c] Claude, [x] Codex, [b] both, [s] skip (default): ')).trim().toLowerCase();
  if(['c','claude','claude-code'].includes(answer))return 'claude-code' as const;
  if(['x','codex'].includes(answer))return 'codex' as const;
  if(['b','both','all'].includes(answer))return 'all' as const;
  if(['','s','skip','n','no'].includes(answer))return 'skip' as const;
  throw new CliError('INVALID_USAGE','No history imported. Choose Claude, Codex, both, or skip.',64);
}
export async function setupBackfill(api:string, mode:string, json=false, options:{concurrency?:number;batchDelayMs?:number}={}) {
  if(mode==='skip')return {status:'skipped'};
  if(mode!=='ask')return backfill(api,selection(mode),true,{...options,onProgress:reportBackfillProgress(json)});
  const preview=backfillPreview(api);
  if(json || !process.stdin.isTTY || !process.stderr.isTTY)return {...preview,status:'decision_required'};
  process.stderr.write(backfillNotice+'\nDestination: '+preview.api+' ('+(preview.owner?.userId??'sign in and install capture before importing')+')\n'+preview.sources.map(s=>s.harness+': '+s.files+' transcript files, '+s.bytes+' bytes').join('\n')+'\n');
  const readline=createInterface({input:process.stdin,output:process.stderr});
  try {
    const chosen=await chooseBackfill(prompt=>readline.question(prompt));
    return chosen==='skip'?{status:'skipped'}:await backfill(api,chosen,true,{...options,onProgress:reportBackfillProgress(json)});
  } finally{readline.close();}
}
