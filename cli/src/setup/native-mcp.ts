import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {CliError} from '../oauth.ts';
import {labels,runPluginCommand,setupPluginIdentity} from './plugins.ts';

export type NativeClient = 'claude-code' | 'codex' | 'antigravity';
export type SetupConnection = {name:string; skipLogin:boolean};
type Inspect = (args:string[])=>Promise<string|undefined>;
const json=(text:string|undefined):unknown=>{try{return JSON.parse(text??'');}catch{return undefined;}};

async function claudeConnections(inspect:Inspect,endpoint:string,managed:string) {
  const matches:SetupConnection[]=[];
  for(const name of ['opencrawl','plugin:opencrawl:opencrawl',managed]){
    const details=await inspect(['mcp','get',name]);
    if(!details)continue;
    const lines=details.trim().split(/\r?\n/).map(line=>line.trim());
    if(!lines.includes(name+':')||!lines.includes('URL: '+endpoint)||!lines.some(line=>/^Type: (?:http|sse)$/i.test(line)))continue;
    const status=lines.find(line=>line.startsWith('Status:'));
    if(!status||/disabled|pending approval/i.test(status))continue;
    const connected=/\bConnected\b/i.test(status)&&!/not connected|disconnected/i.test(status);
    if(connected)return [{name,skipLogin:connected}];
    matches.push({name,skipLogin:connected});
  }
  return matches;
}

function codexConnections(text:string|undefined,endpoint:string,managed:string):SetupConnection[]{
  const rows=json(text);
  if(!Array.isArray(rows))return [];
  const matches:SetupConnection[]=[];
  for(const name of ['opencrawl',managed]){
    const row=rows.find(row=>row?.name===name&&row.enabled===true&&row.transport?.type==='streamable_http'&&row.transport.url===endpoint);
    if(!row)continue;
    // Unsupported means the transport has no native OAuth login. Let the
    // installation proof determine whether it actually serves this workspace.
    const auth=String(row.auth_status).toLowerCase().replaceAll('_','');
    if(auth==='oauth'||auth==='bearertoken')return [{name,skipLogin:true}];
    matches.push({name,skipLogin:auth==='unsupported'});
  }
  return matches;
}

async function antigravityConnections(inspect:Inspect,endpoint:string,managed:string):Promise<SetupConnection[]>{
  const list=await inspect(['mcp','list']);
  // agy lists manually configured servers separately from plugin servers.
  // The list reports enablement only. Its interactive /mcp menu owns OAuth.
  for(const line of (list??'').split(/\r?\n/)){
    const [name,type,status,url]=line.trim().split(/\s+/);
    if(name==='opencrawl'&&type==='http'&&status==='enabled'&&url===endpoint)return [{name,skipLogin:false}];
  }
  const plugins=json(await inspect(['plugin','list','--json']));
  if(!Array.isArray(plugins))return [];
  for(const name of ['opencrawl',managed]){
    const row=plugins.find(row=>row?.enabled===true&&row.name===name&&Array.isArray(row.mcpServers)&&row.mcpServers.includes('opencrawl'));
    if(typeof row?.path!=='string'||!isAbsolute(row.path))continue;
    try{
      const file=await open(join(row.path,'mcp_config.json'),constants.O_RDONLY|constants.O_NONBLOCK);
      try{
        const stat=await file.stat();
        if(!stat.isFile()||stat.size>1024*1024)continue;
        const server=JSON.parse(await file.readFile('utf8')).mcpServers?.opencrawl;
        if(server&&!server.command&&server.disabled!==true&&(server.url??server.serverUrl)===endpoint)return [{name:name+'_opencrawl',skipLogin:false}];
      }finally{await file.close();}
    }catch{}
  }
  return [];
}

/** Resolve the effective native transport before prompting for OAuth. Native
 * connection state can skip a redundant login, never the workspace proof. */
export async function findSetupConnection(client:NativeClient,executable:string,api:string,inspect:Inspect=async args=>{
  const result=await runPluginCommand(executable,args,process.env,12_000);
  return result.code===0?result.stdout:undefined;
}):Promise<SetupConnection>{
  const identity=setupPluginIdentity(api),endpoint=identity.api+'/mcp';
  const rows=client==='claude-code'?await claudeConnections(inspect,endpoint,'plugin:'+identity.name+':opencrawl')
    :client==='codex'?codexConnections(await inspect(['mcp','list','--json']),endpoint,identity.name)
    :await antigravityConnections(inspect,endpoint,identity.name);
  const connection=rows.find(row=>row.skipLogin)??rows[0];
  if(!connection)throw new CliError('NATIVE_MCP_UNAVAILABLE','Setup could not confirm an enabled '+labels[client]+' connection at '+endpoint+'. Check the endpoint in the client’s MCP settings, then run setup again.');
  return connection;
}

export function nativeConnectionPrompt(prompt:string,name:string,api:string){
  return prompt+' Use native MCP server '+name+' at '+api+'/mcp for installation_status and verify_installation. Confirm its workspace and installation match the saved setup.';
}
