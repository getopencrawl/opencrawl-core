import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {inventory} from '../capture/backfill.ts';
import {antigravityDetected} from '../capture/install.ts';
import {defaultClaudeDesktopSessionsRoot} from '../capture/desktop-history.ts';
import {readCaptureConfig} from '../capture/runtime.ts';
import type {SetupClient,SetupSelections} from './state.ts';
import {pluginInventory} from './plugins.ts';
import {newSetupClientAvailable} from './availability.ts';

export function setupInventory({home=homedir(),env=process.env,which=Bun.which,api,platform=process.platform,workload=false,registered=false,client,saved}:{home?:string;env?:NodeJS.ProcessEnv;which?:(name:string)=>string|null;api:string;platform?:NodeJS.Platform;workload?:boolean;registered?:boolean;client?:'claude-code';saved?:SetupSelections}):SetupClient[]{
  if(workload&&env.OPENCRAWL_AUTH==='devin-cloud')return [{id:'devin',label:'Devin Cloud',detected:true,plugin:true,forward:true,history:false,historyFiles:0,historyBytes:0}];
  const previous=readCaptureConfig();
  const roots=previous?.api===api?previous.roots:{'claude-code':env.CLAUDE_CONFIG_DIR||join(home,'.claude'),codex:env.CODEX_HOME||join(home,'.codex'),cursor:env.CURSOR_CONFIG_DIR||join(home,'.cursor'),antigravity:env.ANTIGRAVITY_HOME||join(home,'.gemini')};
  const histories=inventory({roots,claudeDesktopSessionsRoot:previous?.api===api?previous.claudeDesktopSessionsRoot:defaultClaudeDesktopSessionsRoot(home)},client??'all').sources;
  const plugins=pluginInventory({home,env,which});
  const native=[{id:'claude-code',label:'Claude Code',detected:existsSync(roots['claude-code'])||Boolean(which('claude'))||env.CLAUDE_CODE_REMOTE==='true'},
    {id:'codex',label:'Codex',detected:existsSync(roots.codex)||Boolean(which('codex'))},
    {id:'cursor',label:'Cursor',detected:Boolean(roots.cursor&&existsSync(roots.cursor))||Boolean(which('cursor'))||Boolean(which('cursor-agent'))},
    {id:'antigravity',label:'Antigravity',detected:antigravityDetected(home,env)||Boolean(which('agy'))}];
  const ids=new Set(['claude-code','codex','antigravity','cursor',...plugins.map(c=>c.id)].filter(id=>!client||id===client));
  return [...ids].filter(id=>newSetupClientAvailable(id,platform,registered)||saved?.plugins[id]).map(id=>{const local=native.find(c=>c.id===id),plugin=plugins.find(c=>c.id===id),history=histories.find(c=>c.harness===id);return {id,label:plugin?.label??local?.label??id,detected:Boolean(local?.detected||plugin?.detected),plugin:plugin?.supported===true,forward:Boolean(local),history:['claude-code','codex','antigravity'].includes(id),historyFiles:history?.files??0,historyBytes:history?.bytes??0};});
}
