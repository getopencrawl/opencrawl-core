import {readdirSync, statSync, realpathSync} from 'node:fs';
import {join, sep} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {CliError} from '../oauth.ts';
import {captureTranscript, captureDir, flushCaptures, readCaptureConfig, request, recordError, type CaptureConfig} from './runtime.ts';
import type {Harness} from './parse.ts';

export const backfillNotice = 'Import local Claude Code and Codex history, including their desktop coding sessions. Messages, tool arguments/results and available attachments will be uploaded to your signed-in OpenCrawl account. Cloud-only chats are not included.';
type Selection = 'all'|Harness;
export function selection(value = 'all'): Selection {
  if (!['all','claude-code','codex'].includes(value)) throw new CliError('INVALID_USAGE','Choose all, claude-code, or codex.',64);
  return value as Selection;
}
function configFor(api:string) {
  const config=readCaptureConfig();
  if(!config || config.disabled)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install first.');
  if(config.api!==api)throw new CliError('CAPTURE_OWNER_CHANGED','The requested deployment differs from the installed collector. Use its --api or a separate OPENCRAWL_CONFIG_HOME.');
  return config;
}
/** File metadata only: preview never reads transcript contents, spools data, or contacts the server. */
export function inventory(config:CaptureConfig, selected:Selection) {
  const files:{harness:Harness,path:string,bytes:number}[]=[];
  const sources:{harness:Harness,files:number,bytes:number}[]=[];
  for(const harness of ['claude-code','codex'] as Harness[]) {
    if(selected!=='all' && selected!==harness)continue;
    const source={harness,files:0,bytes:0};sources.push(source);
    let root:string;
    try{root=realpathSync(config.roots[harness]);}catch(e:any){if(e.code==='ENOENT')continue;throw new CliError('BACKFILL_SCAN_FAILED','Cannot inspect a local session directory. Check its permissions.');}
    function visit(dir:string) {
      let entries;
      try{entries=readdirSync(dir,{withFileTypes:true});}catch(e:any){if(e.code==='ENOENT')return;throw new CliError('BACKFILL_SCAN_FAILED','Cannot inspect a local session directory. Check its permissions.');}
      for(const entry of entries) {
        const path=join(dir,entry.name);
        // Never follow symlinks out of the native transcript store.
        if(entry.isSymbolicLink())continue;
        if(entry.isDirectory())visit(path);
        else if(entry.isFile() && (path.endsWith('.jsonl') || harness==='codex' && path.endsWith('.jsonl.zst'))) {
          const real=realpathSync(path);
          if(!real.startsWith(root+sep))throw new CliError('CAPTURE_PATH_REJECTED','Session path changed during discovery. Retry the preview.');
          const bytes=statSync(real).size;
          files.push({harness,path:real,bytes});source.files++;source.bytes+=bytes;
        }
      }
    }
    for(const dir of harness==='codex'?['sessions','archived_sessions']:['projects'])visit(join(root,dir));
  }
  return {files,sources};
}
export function backfillPreview(api:string, selected:Selection='all') {
  const config=configFor(api), {sources}=inventory(config,selected);
  return {status:'preview',api:config.api,owner:config.owner,sources,notice:backfillNotice,
    nextStep:'Ask the user whether to import Claude, Codex, both, or skip. Only after they choose, run opencrawl collect backfill --harness <claude-code|codex|all> --yes --api '+config.api+'. To skip during setup, use collect install --backfill skip.'};
}
export async function backfill(api:string, selected:Selection, approved:boolean) {
  // Consent is required even in JSON mode, when stdin is piped, or on a retry.
  if(!approved)throw new CliError('BACKFILL_CONSENT_REQUIRED','Preview with collect backfill --dry-run. Ask the user to choose Claude, Codex, both, or skip; pass --yes only after approval.',64);
  const config=configFor(api);
  const {principal}=await request(config.api,'/api/sessions/identity');
  if(principal?.userId!==config.owner.userId || principal?.tenantId!==config.owner.tenantId)throw new CliError('CAPTURE_OWNER_CHANGED','Sign in as the capture owner before importing history.');
  const {files,sources}=inventory(config,selected);
  let processed=0,uploaded=0;
  const failures:{code:string}[]=[];
  for(const file of files) {
    try{await captureTranscript(config,file.harness,file.path,{},true);processed++;}
    catch(e:any){failures.push({code:e instanceof CliError?e.code:'CAPTURE_FAILED'});recordError(e);}
    // Bound the retry spool to one transcript at a time; stop if the receiver is offline.
    // Completed historical files have no work to send. Keep replay local after
    // the initial owner check; real queued uploads still revalidate ownership.
    if(readdirSync(join(captureDir(),'queue')).some(name=>name.endsWith('.json')))uploaded+=(await flushCaptures()).uploaded;
  }
  if(failures.length) {
    const error=new CliError('BACKFILL_INCOMPLETE',`Imported ${processed} of ${files.length} transcript files; ${failures.length} failed (${failures[0].code}). Fix the reported error and rerun the approved import; saved cursors prevent reimporting completed records.`);
    recordError(error);throw error;
  }
  return {status:'complete',sources,processed,uploaded,notice:'Uploaded counts batches, not sessions. Already captured records are skipped. Only locally available records can be imported.'};
}
export async function chooseBackfill(ask:(prompt:string)=>Promise<string>) {
  const answer=(await ask('Import history? [c] Claude, [x] Codex, [b] both, [s] skip (default): ')).trim().toLowerCase();
  if(['c','claude','claude-code'].includes(answer))return 'claude-code' as const;
  if(['x','codex'].includes(answer))return 'codex' as const;
  if(['b','both','all'].includes(answer))return 'all' as const;
  if(['','s','skip','n','no'].includes(answer))return 'skip' as const;
  throw new CliError('INVALID_USAGE','No history imported. Choose Claude, Codex, both, or skip.',64);
}
export async function setupBackfill(api:string, mode:string, json=false) {
  if(mode==='skip')return {status:'skipped'};
  if(mode!=='ask')return backfill(api,selection(mode),true);
  const preview=backfillPreview(api);
  if(json || !process.stdin.isTTY || !process.stderr.isTTY)return {...preview,status:'decision_required'};
  process.stderr.write(backfillNotice+'\nDestination: '+preview.api+' ('+preview.owner.userId+')\n'+preview.sources.map(s=>s.harness+': '+s.files+' transcript files, '+s.bytes+' bytes').join('\n')+'\n');
  const readline=createInterface({input:process.stdin,output:process.stderr});
  try {
    const chosen=await chooseBackfill(prompt=>readline.question(prompt));
    return chosen==='skip'?{status:'skipped'}:await backfill(api,chosen,true);
  } finally{readline.close();}
}
