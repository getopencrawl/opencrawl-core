import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {setupPluginIdentity,scopedPluginIdentity} from '../setup/plugin-identity.ts';
import {configDir} from '../session.ts';
import {verifyPluginBundle} from '../setup/plugin-context.ts';
import {spawn} from 'node:child_process';
import {powershellQuote} from '../hook-runner.ts';

const owned=new Set(['OpenCrawl session capture','OpenCrawl session startup']);
export type CodexHookReview={state:'not_applicable'|'unknown'|'observed';total:number;pending:number|null;disabled:number|null};
type Snapshot={review:CodexHookReview;file:string;bytes:string;config:string;keys:Map<string,string>;binding?:string;pluginId?:string};
function globalSnapshot(root:string):Snapshot {
 const keys=new Map<string,string>();let file=join(root,'hooks.json'),bytes='',config='';
 try {
  file=realpathSync(file);
  bytes=readFileSync(file,'utf8');
  const value=JSON.parse(bytes) as {hooks?:Record<string,unknown>};
  for(const [event,groups] of Object.entries(value.hooks??{}))if(Array.isArray(groups))groups.forEach((group:unknown,g:number)=>{
   if(!group||typeof group!=='object'||!('hooks' in group)||!Array.isArray(group.hooks))return;
   group.hooks.forEach((hook:unknown,h:number)=>{
    if(hook&&typeof hook==='object'&&'statusMessage' in hook&&typeof hook.statusMessage==='string'&&owned.has(hook.statusMessage))keys.set(`${file}:${event.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase()}:${g}:${h}`,hook.statusMessage);
   });
  });
  if(existsSync(join(root,'config.toml')))config=readFileSync(join(root,'config.toml'),'utf8');
 } catch {return {file,bytes,config,keys,review:{state:existsSync(file)?'unknown':'not_applicable',total:keys.size,pending:existsSync(file)?null:0,disabled:existsSync(file)?null:0}};}
 return {file,bytes,config,keys,review:{state:keys.size?'unknown':'not_applicable',total:keys.size,pending:keys.size?null:0,disabled:keys.size?null:0}};
}
/** A plugin enrollment must never inherit readiness from another deployment's
 * global hooks. The installer receipt binds the exact native cache and marker. */
function snapshot(root:string):Snapshot {
 let captureBytes='',capture:{hookOwnership?:string;harnesses?:string[];api:string;roots?:{codex?:string}}|undefined;
 try{captureBytes=readFileSync(join(configDir(),'capture/config.json'),'utf8');capture=JSON.parse(captureBytes);}catch{}
 if(capture?.hookOwnership!=='plugin'||typeof capture.roots?.codex!=='string'||resolve(capture.roots.codex)!==resolve(root))return globalSnapshot(root);
 const keys=new Map<string,string>();
 const result:Snapshot={file:'',bytes:'',config:'',keys,binding:captureBytes,review:{state:'unknown',total:0,pending:null,disabled:null}};
 // This is capture readiness, not a requirement to enable recording for search.
 if(!capture.harnesses?.includes('codex'))return {...result,review:{state:'not_applicable',total:0,pending:0,disabled:0}};
 try{
  const identity=setupPluginIdentity(capture.api),legacy=scopedPluginIdentity(capture.api),key=identity.key;
  const receiptBytes=readFileSync(join(configDir(),'setup-plugins/codex',key,'installed.json'),'utf8');
  const receipt=JSON.parse(receiptBytes);
  const {name,marketplace}=receipt.pluginName===legacy.name?legacy:identity,pluginId=name+'@'+marketplace;
  if(receipt.schemaVersion!==2||receipt.api!==capture.api||receipt.client!=='codex'||receipt.pluginName!==name||receipt.pluginId!==pluginId||typeof receipt.nativeRoot!=='string')return result;
  const bundle=verifyPluginBundle({nativeRoot:receipt.nativeRoot,api:capture.api,client:'codex',pluginName:name,configHome:dirname(configDir())});
  if(bundle.digest!==receipt.digest||!('hooks/hooks.json' in bundle.files))return result;
  // The verified manifest owns these hooks, including bundles with older display labels.
  const file=join(bundle.root,'hooks/hooks.json'),bytes=readFileSync(file,'utf8'),value=JSON.parse(bytes) as {hooks?:Record<string,unknown>};
  for(const [event,groups] of Object.entries(value.hooks??{}))if(Array.isArray(groups))groups.forEach((group:unknown,g:number)=>{
   if(!group||typeof group!=='object'||!('hooks' in group)||!Array.isArray(group.hooks))return;
   group.hooks.forEach((hook:unknown,h:number)=>{
    if(hook&&typeof hook==='object'&&'statusMessage' in hook&&typeof hook.statusMessage==='string')keys.set(`${pluginId}:hooks/hooks.json:${event.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase()}:${g}:${h}`,hook.statusMessage);
   });
  });
  const config=existsSync(join(root,'config.toml'))?readFileSync(join(root,'config.toml'),'utf8'):'';
  return {...result,file,bytes,config,pluginId,binding:JSON.stringify([captureBytes,receiptBytes,bundle.digest,bundle.files]),review:{state:'unknown',total:keys.size,pending:null,disabled:null}};
 }catch{return result;}
}
/** Local files establish ownership, never trust in a current hook definition. */
export function localCodexHookReview(root:string):CodexHookReview{return snapshot(root).review;}

/** Read native metadata without starting a thread or executing any hook. */
export async function nativeCodexHooks(root:string):Promise<unknown>{
 const executable=Bun.which('codex');if(!executable)throw new Error('Codex unavailable');
 let command=executable,args=['app-server','--stdio'];
 if(process.platform==='win32'&&/\.(cmd|bat)$/i.test(command)){
  args=['-NoProfile','-NonInteractive','-Command','& '+[command,...args].map(powershellQuote).join(' ')+'; exit $LASTEXITCODE'];
  command=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 }
 return await new Promise((accept,reject)=>{
  const child=spawn(command,args,{cwd:root,env:{...process.env,CODEX_HOME:root},stdio:['pipe','pipe','pipe'],windowsHide:true});
  let buffer='',bytes=0,finished=false;
  const finish=(error:Error|null,value?:unknown)=>{
   if(finished)return;finished=true;clearTimeout(deadline);child.stdin.end();
   if(process.platform==='win32'&&child.pid){
    // A .cmd launcher may own a native child; terminate only this process tree.
    const killer=spawn(join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});killer.on('error',()=>child.kill());killer.unref();
   }else child.kill();
   const kill=setTimeout(()=>child.kill('SIGKILL'),500);kill.unref();child.once('close',()=>clearTimeout(kill));
   if(error)reject(error);else accept(value);
  };
  const deadline=setTimeout(()=>finish(new Error('Codex hook inspection timed out')),5000);
  const send=(message:unknown)=>child.stdin.write(JSON.stringify(message)+'\n');
  child.on('error',()=>finish(new Error('Codex hook inspection unavailable')));
  child.stdin.on('error',()=>finish(new Error('Codex hook inspection unavailable')));
  child.once('exit',()=>{if(!finished)finish(new Error('Codex hook inspection ended early'));});
  child.stderr.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2*1024*1024)finish(new Error('Codex hook inspection output exceeded limit'));});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{
   if(finished)return;bytes+=Buffer.byteLength(chunk);if(bytes>2*1024*1024){finish(new Error('Codex hook inspection output exceeded limit'));return;}
   buffer+=chunk;let end:number;
   while((end=buffer.indexOf('\n'))>=0&&!finished){
    const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
    let message:{id?:unknown;error?:unknown;result?:unknown};try{const parsed:unknown=JSON.parse(line);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Invalid response');message=parsed;}catch{finish(new Error('Invalid Codex hook response'));return;}
    if(message.id===1){if(message.error){finish(new Error('Codex hook inspection unsupported'));return;}send({method:'initialized',params:{}});send({id:2,method:'hooks/list',params:{cwds:[root]}});}
    if(message.id===2)finish(message.error?new Error('Codex hook inspection unavailable'):null,message.result);
   }
  });
  send({id:1,method:'initialize',params:{clientInfo:{name:'opencrawl_hook_status',version:'1'},capabilities:{experimentalApi:true}}});
 });
}
export async function inspectCodexHooks(root:string,query=nativeCodexHooks):Promise<CodexHookReview>{
 const before=snapshot(root);if(before.review.state==='not_applicable')return before.review;
 try {
  const value=await query(root),after=snapshot(root);
  if(after.file!==before.file||after.bytes!==before.bytes||after.config!==before.config||after.binding!==before.binding||after.pluginId!==before.pluginId||!value||typeof value!=='object'||!('data' in value)||!Array.isArray(value.data))return before.review;
  const hooks:Record<string,unknown>[]=[];
  for(const entry of value.data){if(!entry||typeof entry!=='object'||!Array.isArray(entry.hooks)||!Array.isArray(entry.errors)||entry.errors.length)return before.review;
   for(const hook of entry.hooks)if(hook&&typeof hook==='object'&&typeof hook.sourcePath==='string'&&(before.pluginId||owned.has(hook.statusMessage))){
    if(before.pluginId){
     if(hook.source==='plugin'&&hook.pluginId===before.pluginId&&realpathSync(hook.sourcePath)===realpathSync(before.file))hooks.push(hook);
    }else if(hook.sourcePath===before.file||resolve(hook.sourcePath)===resolve(root,'hooks.json')){
     // Codex can report the physical path even when CODEX_HOME uses a symlink.
     if(typeof hook.key!=='string'||!hook.key.startsWith(hook.sourcePath+':'))return before.review;
     hooks.push({...hook,key:before.file+hook.key.slice(hook.sourcePath.length)});
    }
   }
  }
  if(!before.keys.size||hooks.length!==before.keys.size||new Set(hooks.map(h=>h.key)).size!==before.keys.size||hooks.some(h=>typeof h.statusMessage!=='string'||before.keys.get(String(h.key))!==h.statusMessage||typeof h.enabled!=='boolean'||!['managed','trusted','untrusted','modified'].includes(String(h.trustStatus))))return before.review;
  return {state:'observed',total:hooks.length,pending:hooks.filter(h=>h.enabled&&['untrusted','modified'].includes(String(h.trustStatus))).length,disabled:hooks.filter(h=>!h.enabled).length};
 } catch {return before.review;}
}
export function codexHookReviewMessage(review:CodexHookReview):string|null{
 if(review.state==='unknown')return 'Codex hook trust could not be verified. Open /hooks (or desktop Settings > Hooks) to review the hooks installed by OpenCrawl. Trust the ones you want to run, then start a new session.';
 if(review.pending)return `Codex will not run ${review.pending} OpenCrawl hook${review.pending===1?'':'s'} until you approve them. Open /hooks (or desktop Settings > Hooks), review the hooks installed by OpenCrawl, then start a new session.${review.disabled?` Another ${review.disabled} OpenCrawl hook${review.disabled===1?' is':'s are'} disabled; keep intentional opt-outs.`:''}`;
 return review.disabled?`${review.disabled} OpenCrawl hook${review.disabled===1?' is':'s are'} disabled in Codex. Review /hooks (or desktop Settings > Hooks); keep intentional opt-outs, or enable the hooks you want to use.`:null;
}
