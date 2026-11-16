import {posix,win32} from 'node:path';
import {apiOrigin,CliError} from '../oauth.ts';
import {GROK_BOT_HOOK_EVENTS} from '../capture/grok-bot.ts';
import {pluginSearchContextMatcher,searchContextMarker} from '../search-context.ts';
import type {PluginClient} from './plugins.ts';
import {DEVIN_HOOK_EVENTS} from '../capture/devin.ts';

export type PluginHookBinding={command:string[];configHome:string;api:string;pluginName:string};
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const captureMarker='OpenCrawl session capture',startupMarker='OpenCrawl session startup';
const ambientAuth=['OPENCRAWL_TOKEN','OPENCRAWL_SESSIONS_TOKEN','OPENCRAWL_AUTH','OPENCRAWL_API_URL'];
const literal=(value:string,windows:boolean)=>windows?'"'+value.replaceAll('%','%%').replaceAll('"','""')+'"':"'"+value.replaceAll("'","'\\''")+"'";

/** Native plugin hooks own delivery; the CLI guard owns endpoint/installation and
 * saved forward-consent checks. No credentials or global hook files live here.
 * The hook child uses saved profile auth, never ambient tokens/workload auth.
 * OPENCRAWL_PLUGIN_ROOT is derived by the bundled runner, including in a native
 * plugin cache. The guard verifies that root's marker and complete file hashes.
 */
export function pluginHookFiles(client:PluginClient,binding:PluginHookBinding,platform=process.platform):Record<string,string>{
 if(client==='devin'&&platform!=='linux')throw new CliError('INVALID_PLUGIN_BINDING','Devin Cloud bundles require a Linux native command.');
 const windows=platform==='win32',path=windows?win32:posix;
 const {command,configHome,pluginName}=binding,api=apiOrigin(binding.api);
 if(!command.length||!path.isAbsolute(command[0])||!path.isAbsolute(configHome)
   ||!/^opencrawl(?:-[a-z0-9]+)?$/.test(pluginName)
   ||[...command,configHome,pluginName,api].some(value=>/[\x00-\x1f\x7f]/.test(value)||windows&&value.includes('"')))
  throw new CliError('INVALID_PLUGIN_BINDING','Plugin hooks need an absolute CLI and profile with a valid OpenCrawl plugin name.');
 const env:Record<string,string>={OPENCRAWL_CONFIG_HOME:configHome,OPENCRAWL_PLUGIN_API:api,OPENCRAWL_PLUGIN_NAME:pluginName,OPENCRAWL_PLUGIN_CLIENT:client};
 const runner=windows?'scripts/opencrawl-hook.cmd':'scripts/opencrawl-hook.sh';
 const cloudGuard=client==='devin'?'[ -z "${OPENCRAWL_TOKEN-}${OPENCRAWL_SESSIONS_TOKEN-}" ] || exit 1\ncase "${OPENCRAWL_AUTH-devin-cloud}" in devin-cloud) ;; *) exit 1 ;; esac\n':'';
 const script=windows
  ?'@echo off\r\nsetlocal DisableDelayedExpansion\r\n'+ambientAuth.map(key=>'set "'+key+'="\r\n').join('')+Object.entries(env).map(([key,value])=>'set "'+key+'='+value.replaceAll('%','%%')+'"\r\n').join('')
   +'for %%I in ("%~dp0..") do set "OPENCRAWL_PLUGIN_ROOT=%%~fI"\r\n'+command.map(value=>literal(value,true)).join(' ')+' %*\r\n'
  :'#!/bin/sh\n'+cloudGuard+'unset '+ambientAuth.join(' ')+'\n'+Object.entries(env).map(([key,value])=>'export '+key+'='+literal(value,false)+'\n').join('')
   +(client==='devin'?"export OPENCRAWL_AUTH='devin-cloud'\nexport PATH='/usr/local/bin:/usr/bin:/bin'\n":'')
   +'OPENCRAWL_PLUGIN_ROOT=$(CDPATH= cd -- "${0%/*}/.." && pwd -P) || exit 0\nexport OPENCRAWL_PLUGIN_ROOT\nexec '+command.map(value=>literal(value,false)).join(' ')+' "$@"\n';
 // Codex 0.166 uses the session's Windows shell (PowerShell by default);
 // it does not support Claude's per-handler shell override.
 // Use process environment expansion, not inline path substitution: quotes,
 // dollars and percent signs in native cache paths must remain path characters.
 const root=client==='codex'||client==='devin'?'PLUGIN_ROOT':client==='claude-code'?'CLAUDE_PLUGIN_ROOT':'CURSOR_PLUGIN_ROOT';
 const invocation=windows
  ?client==='claude-code'||client==='codex'?{command:'& "$env:'+root+'\\scripts\\opencrawl-hook.cmd"',...(client==='claude-code'?{shell:'powershell' as const}:{})}
   :{command:client==='antigravity'?'".\\scripts\\opencrawl-hook.cmd"':'"%'+root+'%\\scripts\\opencrawl-hook.cmd"'}
  :{command:client==='antigravity'?'/bin/sh ./scripts/opencrawl-hook.sh':'/bin/sh "$'+root+'/scripts/opencrawl-hook.sh"'};
 const args=(values:string[])=>values.map(value=>/^[a-zA-Z0-9_:/.-]+$/.test(value)?value:literal(value,windows)).join(' ');
 const startup={type:'command',...invocation,command:invocation.command+' '+args(['session','start','--harness',client,'--api',api]),timeout:7,statusMessage:startupMarker};
 const search={type:'command',...invocation,command:invocation.command+' '+args(['search-context','--harness',client,'--api',api]),timeout:2,statusMessage:searchContextMarker};
 const searchMatcher=pluginSearchContextMatcher(client,pluginName);
 const capture=(event:string)=>{
  const daemon=client==='claude-code';
  const managed=client==='codex'&&event!=='SessionEnd';
  return {type:'command',...invocation,command:invocation.command+' '+args(['collect','hook','--harness',client,'--api',api,...(client==='antigravity'?['--event',event]:[])]),
   timeout:daemon?120:managed?120:client==='codex'?3:30,statusMessage:captureMarker,...(managed||daemon?{async:true}:{})};
 };
 if(client==='devin'){
  const hooks=Object.fromEntries(DEVIN_HOOK_EVENTS.map(event=>[event,[{hooks:[event==='SessionStart'
   ?{type:'command',command:invocation.command+' '+args(['workload','start','--api',api]),timeout:120}
   :{type:'command',command:capture(event).command,timeout:5}]}]]));
  return {[runner]:script,'hooks.json':json(hooks)};
 }
 if(client==='cursor'){
  const hooks:Record<string,unknown[]>=Object.fromEntries(GROK_BOT_HOOK_EVENTS.map(event=>{const entry=capture(event);return [event,[{command:entry.command,timeout:entry.timeout}]];}));
  (hooks.preToolUse??=[]).unshift({matcher:searchMatcher,command:search.command,timeout:search.timeout});
  hooks.sessionStart.unshift({command:startup.command,timeout:startup.timeout});
  hooks.postToolUse.unshift({command:startup.command+' --after-tool',timeout:startup.timeout});
  return {[runner]:script,'hooks/hooks.json':json({version:1,hooks})};
 }
 if(client==='antigravity'){
  const entry=(event:string)=>{const hook=capture(event);return {type:hook.type,command:hook.command,timeout:hook.timeout};};
  return {[runner]:script,'hooks.json':json({[pluginName+'-startup']:{SessionStart:[{type:startup.type,command:startup.command,timeout:startup.timeout}],PreToolUse:[{matcher:searchMatcher,hooks:[{type:search.type,command:search.command,timeout:search.timeout}]}]},
   [pluginName+'-capture']:{SessionStart:[entry('SessionStart')],PostToolUse:[{matcher:'*',hooks:[entry('PostToolUse')]}],PostInvocation:[entry('PostInvocation')],Stop:[entry('Stop')]}})};
 }
 const events=client==='claude-code'?['SessionStart','UserPromptSubmit','Stop','SessionEnd']
  :['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','SubagentStop','SessionEnd'];
 const hooks:Record<string,unknown[]>=Object.fromEntries(events.map(event=>[event,[{hooks:event==='SessionStart'?[startup,capture(event)]:[capture(event)]}]]));
 (hooks.PreToolUse??=[]).push({matcher:searchMatcher,hooks:[search]});
 return {[runner]:script,'hooks/hooks.json':json({hooks})};
}
