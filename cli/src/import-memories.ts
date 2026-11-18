import {createHash, randomUUID} from 'node:crypto';
import {closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {CliError} from './oauth.ts';

type Scope = {api:string; workspace:string; user:string};
type Args = {host?:string; harness?:string; installation?:string; path?:string[]; store?:string; list?:boolean};
type Provenance = {userId:string; installationId:string; host:string; harness:string; path:string; snapshotId:string; modifiedAt:string; chunk:number; kind:string};
type Bounds = {index:number; count:number; start:number; end:number};
type Hit = {id:string; source:string; provenance:Provenance; passage?:Bounds};
type Fetched = Hit & {text:string; version:string; offset:number; totalChars:number; nextOffset:number|null; previousId?:string; nextId?:string};
type Page = {results:Hit[]; next:string|null; partial:boolean; windowExhausted:boolean; coverage:{source:string; state:string; truncated:boolean}[]};
type Reader = {search(input:Record<string,unknown>):Promise<Page>; fetch(input:Record<string,unknown>):Promise<Fetched>};
type Outcome = {path:string; host:string; harness:string; installationId:string; status:'verified'|'imported'|'unchanged'|'conflict'|'failed'; local?:string; error?:string};
const digest = (parts:string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,24);
const clean = (label:string) => label.replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/^[.-]+/,'').slice(0,80) || 'source';
const memoryId = (id:unknown):id is string => typeof id==='string' && /^memories:[0-9a-f]{64}$/.test(id);
function requireData(ok:unknown,message:string):asserts ok {
  if(!ok)throw new CliError('MEMORY_IMPORT_INCOMPLETE',message);
}
function fileKey(hit:Hit,scope:Scope) {
  const p=hit.provenance;
  requireData(memoryId(hit.id) && hit.source==='memories' && p?.kind==='passage' && p.userId===scope.user &&
    [p.installationId,p.host,p.harness,p.path,p.snapshotId].every(v=>typeof v==='string' && v.length>0), 'Invalid caller or memory provenance.');
  return JSON.stringify([p.installationId,p.host,p.harness,p.path]);
}

async function discover(reader:Reader,scope:Scope,args:Args) {
  const files=new Map<string,Hit>(), warnings:string[]=[];
  const filters={authors:[scope.user],...(args.harness?{harnesses:[args.harness]}:{}),...(args.path?{paths:args.path}:{})};
  let before:number|undefined;
  for (;;) {
    let oldest=Infinity, cursor:string|null=null, truncated=false;
    const seen=new Set<string>();
    do {
      const page=await reader.search({source:'memories',query:'',order:'newest',groupBy:'resource',select:['provenance'],limit:40,
        filters:{...filters,...(before===undefined?{}:{before:new Date(before).toISOString()})},...(cursor?{cursor}:{})});
      const coverage=page.coverage?.[0];
      requireData(page.partial===false && page.coverage.length===1 && coverage?.source==='memories' && coverage.state==='ready','The memory index is unavailable or partial. Retry discovery.');
      for(const hit of page.results) {
        const key=fileKey(hit,scope),p=hit.provenance,stamp=Date.parse(p.modifiedAt);
        requireData(Number.isFinite(stamp) && (before===undefined||stamp<=before) && (!args.harness||args.harness===p.harness) && (!args.path||args.path.includes(p.path)),'Search returned a memory outside the requested filters.');
        oldest=Math.min(oldest,stamp);
        if(args.host && p.host!==args.host || args.installation && p.installationId!==args.installation)continue;
        const previous=files.get(key);
        requireData(!previous||previous.provenance.snapshotId===p.snapshotId,'A source snapshot changed during discovery. Retry.');
        files.set(key,hit);
      }
      truncated=page.windowExhausted||coverage.truncated;
      cursor=page.next;
      if(cursor){requireData(!seen.has(cursor),'Search repeated a cursor.');seen.add(cursor);}
    } while(cursor);
    if(!truncated)break;
    if(!Number.isFinite(oldest)){warnings.push('The search window ended without a time boundary.');break;}
    // Time bounds are inclusive. Replay a boundary to collect files split across a tie.
    if(before===oldest){warnings.push('Search limit at '+new Date(oldest).toISOString()+'. Narrow by exact path for additional files.');oldest--;}
    before=oldest;
  }
  return {files:[...files.values()],warnings};
}

async function completeFile(reader:Reader,scope:Scope,hit:Hit) {
  const key=fileKey(hit,scope), anchor=hit.passage;
  requireData(anchor && Number.isInteger(anchor.index) && Number.isInteger(anchor.count) && anchor.count>0 && anchor.count<=4096 &&
    anchor.index>=0 && anchor.index<anchor.count,'Missing file passage boundaries.');
  const chunks:{start:number;end:number;text:string}[]=new Array(anchor.count);
  async function chunk(id:string|undefined,index:number) {
    requireData(memoryId(id),'Incomplete memory passage chain.');
    let offset=0, version:string|undefined;
    const pieces:string[]=[];
    for (;;) {
      const part=await reader.fetch({id,offset,length:16000,...(version?{version}:{})});
      const bounds=part.passage;
      requireData(part.id===id && fileKey(part,scope)===key && part.provenance.snapshotId===hit.provenance.snapshotId &&
        part.provenance.chunk===index && bounds?.index===index && bounds.count===anchor!.count && part.offset===offset &&
        typeof part.version==='string' && part.version && (!version||part.version===version) && typeof part.text==='string','Memory provenance, position or version changed. Retry.');
      pieces.push(part.text); offset+=part.text.length; version=part.version;
      if(part.nextOffset===null) {
        requireData(offset===part.totalChars && bounds.end-bounds.start===offset,'Truncated memory passage.');
        chunks[index]={start:bounds.start,end:bounds.end,text:pieces.join('')}; return part;
      }
      requireData(part.text.length>0 && part.nextOffset===offset && offset<part.totalChars,'Invalid memory page offset.');
    }
  }
  const center=await chunk(hit.id,anchor.index);
  let last=center;
  for(let i=anchor.index-1;i>=0;i--)last=await chunk(last.previousId,i);
  last=center;
  for(let i=anchor.index+1;i<anchor.count;i++)last=await chunk(last.nextId,i);
  let end=0;
  for(const c of chunks){requireData(c.start===end,'Gap or overlap in file passages.');end=c.end;}
  return Buffer.from(chunks.map(c=>c.text).join(''));
}

// Create missing components one at a time. Reject symlinks, including dangling ones.
function privateDirectory(path:string) {
  const parent=dirname(path);
  if(parent!==path)privateDirectory(parent);
  let stat=lstatSync(path,{throwIfNoEntry:false});
  if(!stat){
    try {mkdirSync(path,{mode:0o700});} catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    stat=lstatSync(path);
  }
  requireData(stat.isDirectory()&&!stat.isSymbolicLink(),'Choose a private canonical directory without symbolic links.');
}

function save(referenceDirectory:string,p:Provenance,bytes:Buffer) {
  const parts=p.path.split('/');
  requireData(p.path.endsWith('.md') && parts.every(v=>v&&!v.startsWith('.')&&!/[<>:"\\|?*\x00-\x1f\x7f]/.test(v)&&!/[. ]$/.test(v)&&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v)),'Unsafe captured path.');
  const target=join(referenceDirectory,clean(p.host)+'-'+clean(p.harness)+'-'+digest([p.installationId,p.harness]),...parts);
  const parent=dirname(target);
  privateDirectory(parent);
  const temp=join(parent,'.import-'+randomUUID());
  const fd=openSync(temp,'wx',0o600);
  try {
    try {writeFileSync(fd,bytes);fsyncSync(fd);} finally {closeSync(fd);}
    try {linkSync(temp,target);return {status:'imported' as const,local:target};}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    requireData(lstatSync(target).isFile(),'Existing import path is not a regular file.');
    const existing=openSync(target,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try {return {status:readFileSync(existing).equals(bytes)?'unchanged' as const:'conflict' as const,local:target};}
    finally {closeSync(existing);}
  } finally {unlinkSync(temp);}
}

export async function importMemories(action:string,scope:Scope,args:Args,reader:Reader) {
  if(!scope.user||!scope.workspace)throw new CliError('AUTH_REQUIRED','Select a personal sign-in and workspace.',2);
  if(!['scan','verify','import'].includes(action)||action!=='scan'&&(!args.host||!args.harness)||
      args.path&&(!args.path.length||args.path.length>20)||action==='import'&&(!args.store||!isAbsolute(args.store)))
    throw new CliError('INVALID_USAGE','Use memories scan, verify or import. Verify/import require --host and --harness. Import requires an absolute --store. Choose at most 20 exact paths.',64);
  const {files,warnings}=await discover(reader,scope,args);
  const groups=new Map<string,{host:string;harness:string;installationId:string;files:number}>();
  const inventory=files.map(hit=>{
    const {host,harness,installationId,path,modifiedAt}=hit.provenance,key=JSON.stringify([host,harness,installationId]);
    const group=groups.get(key)??{host,harness,installationId,files:0};group.files++;groups.set(key,group);
    return {host,harness,installationId,path,modifiedAt};
  });
  const sources=[...groups.values()],selected=new Set(inventory.map(f=>f.path));
  const missing=args.path?.filter(path=>!selected.has(path))??[];
  if(missing.length)warnings.push('Requested paths missing: '+JSON.stringify(missing));
  const report={sources,discovered:files.length,warnings,complete:warnings.length===0};
  if(action==='scan')return {...report,...(args.list?{files:inventory}:{})};
  if(missing.length)return {...report,results:[],outcomes:{}};
  const referenceDirectory=args.store?join(resolve(args.store),digest([scope.api,scope.workspace,scope.user])):undefined;
  const results:Outcome[]=[];
  for(const hit of files) {
    const {host,harness,installationId,path}=hit.provenance;
    try {
      const bytes=await completeFile(reader,scope,hit);
      results.push({host,harness,installationId,path,...(action==='import'?save(referenceDirectory!,hit.provenance,bytes):{status:'verified' as const})});
    } catch(error) {
      results.push({host,harness,installationId,path,status:'failed',error:error instanceof Error?error.message:'File unavailable'});
      // Preserve completed files and leave the rest for a safe retry on scope/transport failure.
      break;
    }
  }
  const outcomes:Partial<Record<Outcome['status'],number>>={};
  for(const r of results)outcomes[r.status]=(outcomes[r.status]??0)+1;
  return {...report,results,outcomes,complete:report.complete&&!outcomes.failed&&!outcomes.conflict,
    ...(outcomes.imported||outcomes.unchanged?{referenceDirectory}:{})};
}
