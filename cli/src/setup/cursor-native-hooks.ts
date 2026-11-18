import {createHash} from 'node:crypto';
import {apiOrigin} from '../oauth.ts';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {atomicJson,withFileLock,configDir} from '../session.ts';
import {CliError} from '../oauth.ts';
import {quote} from '../hook-runner.ts';

type Entry=Record<string,unknown>;
type Hooks=Record<string,Entry[]>;
const object=(value:unknown):value is Entry=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function read(file:string):Entry{
 if(!existsSync(file))return {};
 if(lstatSync(file).isSymbolicLink())throw new CliError('CURSOR_HOOK_CONFLICT','Cursor hooks must be an ordinary file; existing hooks were preserved.');
 const value:unknown=JSON.parse(readFileSync(file,'utf8'));
 if(!object(value))throw new CliError('CURSOR_HOOK_CONFLICT','Invalid Cursor hooks; existing hooks were preserved.');
 return value;
}
function hooks(value:unknown):Hooks{
 if(value===undefined)return {};
 if(!object(value)||Object.values(value).some(rows=>!Array.isArray(rows)||rows.some(row=>!object(row))))throw new CliError('CURSOR_HOOK_CONFLICT','Invalid Cursor hooks; existing hooks were preserved.');
 return value as Hooks;
}
/** Cursor 3.30 gates plugin hooks behind broad third-party imports. Native user
 * hooks are supported independently. Own only exact recorded entries, never a
 * command substring or another deployment's wrapper. */
export async function reconcileCursorNativeHooks(root:string,directory:string,receipt:string,definition?:string,preflight=false,migrating=false){
 if(existsSync(root)&&lstatSync(root).isSymbolicLink())throw new CliError('CURSOR_HOOK_CONFLICT','Cursor configuration must be an ordinary directory.');
 return withFileLock(join(root,'.opencrawl-hooks.lock'),async()=>{
  const file=join(root,'hooks.json'),before=read(file),current=hooks(before.hooks),saved=read(receipt);
  if(Object.keys(saved).length&&(saved.file!==file||saved.directory!==directory))throw new CliError('CURSOR_HOOK_CONFLICT','Cursor hook ownership changed; existing hooks were preserved.');
  const prior=hooks(saved.hooks),desired=definition?hooks(JSON.parse(definition).hooks):{};
  if(migrating){
   const owned=Object.values(prior).flat(),entries=Object.values(current).flat();
   if(before.enabled===false||entries.some(entry=>owned.some(row=>row.command===entry.command)&&(!owned.some(row=>isDeepStrictEqual(row,entry))||entry.enabled===false)))throw new CliError('CURSOR_HOOK_CONFLICT','An owned Cursor hook is disabled or changed. Preserve that choice and review migration to plugin hooks in Cursor before resuming.');
  }
  const invocation=process.platform==='win32'?quote(join(directory,'scripts','opencrawl-cursor-native.cmd')):'/bin/sh '+quote(join(directory,'scripts','opencrawl-cursor-native.sh'));
  const rootCommand=process.platform==='win32'?'"%CURSOR_PLUGIN_ROOT%\\scripts\\opencrawl-hook.cmd"':'/bin/sh "$CURSOR_PLUGIN_ROOT/scripts/opencrawl-hook.sh"';
  for(const entries of Object.values(desired))for(const entry of entries){
   if(typeof entry.command!=='string'||!entry.command.startsWith(rootCommand+' '))throw new CliError('CURSOR_HOOK_CONFLICT','Invalid generated Cursor hook.');
   entry.command=invocation+entry.command.slice(rootCommand.length);
  }
  if(definition&&(before.enabled===false||Object.values(current).flat().some(entry=>entry.enabled===false&&[...Object.values(prior).flat(),...Object.values(desired).flat()].some(row=>row.command===entry.command))))throw new CliError('CURSOR_HOOK_DISABLED','An owned Cursor hook is explicitly disabled; preserve that choice and review it in Cursor before resuming.');
  if(before.version!==undefined&&before.version!==1)throw new CliError('CURSOR_HOOK_CONFLICT','Unsupported Cursor hook version; existing hooks were preserved.');
  const next:Hooks={};
  for(const event of new Set([...Object.keys(current),...Object.keys(desired)])){
   const old=prior[event]??[],wanted=desired[event]??[],remaining=[...wanted];
   next[event]=(current[event]??[]).flatMap(entry=>{
    if(!old.some(owned=>isDeepStrictEqual(owned,entry)))return [entry];
    const index=remaining.findIndex(row=>isDeepStrictEqual(row,entry));
    if(index<0)return [];
    return remaining.splice(index,1);
   });
   next[event].push(...remaining);
   if(!next[event].length)delete next[event];
  }
  if(preflight)return;
  // Write ownership first: interrupted installation can safely reconcile exact
  // desired entries on retry; no existing foreign hook becomes owned.
  const owned=Object.fromEntries([...new Set([...Object.keys(prior),...Object.keys(desired)])].map(event=>[event,[...(prior[event]??[]),...(desired[event]??[])]]));
  atomicJson(receipt,{file,directory,hooks:owned});
  atomicJson(file,{...before,version:before.version??1,hooks:next});
  atomicJson(receipt,{file,directory,hooks:desired});
 });
}

/** One-time retirement of exact owned user entries. New hooks live only in the
 * canonical plugin; modified/disabled entries require native review. */
export async function retireCursorSetupHooks(api:string,root:string,preflight=false){
 const key=createHash('sha256').update(apiOrigin(api)).digest('hex').slice(0,12);
 const receipt=join(configDir(),'setup-plugins','cursor',key,'native-hooks.json');
 if(!existsSync(receipt))return;
 await reconcileCursorNativeHooks(root,join(root,'plugins','local','opencrawl-'+key),receipt,undefined,preflight,true);
}

export async function removeCursorSetupHooks(api:string,root?:string){
 if(!root)return;
 const key=createHash('sha256').update(apiOrigin(api)).digest('hex').slice(0,12);
 const receipt=join(configDir(),'setup-plugins','cursor',key,'native-hooks.json');
 if(!existsSync(receipt))return;
 await reconcileCursorNativeHooks(root,join(root,'plugins','local','opencrawl-'+key),receipt);
}
