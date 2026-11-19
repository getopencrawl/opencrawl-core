import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findSetupConnection} from '../src/setup/native-mcp.ts';
import {scopedPluginIdentity} from '../src/setup/plugin-identity.ts';

const api='https://selected.example',endpoint=api+'/mcp',scoped=scopedPluginIdentity(api).name;
const details=(name:string,url:string,status:string)=>[name+':','  Scope: User config','  Status: '+status,'  Type: http','  URL: '+url].join('\n');
test('Claude uses the already connected MCP that hides the plugin alias for the same endpoint',async()=>{
  const calls:string[][]=[];
  const connection=await findSetupConnection('claude-code','claude',api,async args=>{
    calls.push(args);
    return args[2]==='opencrawl'?details('opencrawl',endpoint,'✓ Connected'):undefined;
  });
  expect(connection).toEqual({name:'opencrawl',skipLogin:true});
  expect(calls).toEqual([['mcp','get','opencrawl']]);
});
test('Claude uses the managed server when a generic server is disabled or belongs to a different deployment',async()=>{
  const name='plugin:'+scoped+':opencrawl';
  for(const generic of [details('opencrawl',api+'/other','✓ Connected'),details('opencrawl',endpoint,'Disabled'),details('opencrawl',endpoint,'Pending approval')]){
    expect(await findSetupConnection('claude-code','claude',api,async args=>args[2]==='opencrawl'?generic:args[2]===name?details(name,endpoint,'! Needs authentication'):undefined)).toEqual({name,skipLogin:false});
  }
});
test('Codex reuses valid native OAuth or bearer auth and ignores disabled and different-endpoint entries',async()=>{
  const row=(name:string,auth_status:string,url=endpoint,enabled=true)=>({name,auth_status,enabled,transport:{type:'streamable_http',url}});
  const select=(rows:unknown[])=>findSetupConnection('codex','codex',api,async()=>JSON.stringify(rows));
  for(const auth of ['oauth','bearer_token']){
    expect(await select([row(scoped,'not_logged_in'),row('opencrawl',auth)])).toEqual({name:'opencrawl',skipLogin:true});
    expect(await select([row('opencrawl','unsupported'),row(scoped,auth)])).toEqual({name:scoped,skipLogin:true});
  }
  for(const generic of [row('opencrawl','oauth',api+'/other'),row('opencrawl','oauth',endpoint,false)]){
    expect(await select([generic,row(scoped,'not_logged_in')])).toEqual({name:scoped,skipLogin:false});
  }
  await expect(select([row('opencrawl','oauth','https://other.example/mcp')])).rejects.toMatchObject({code:'NATIVE_MCP_UNAVAILABLE'});
});
test('Antigravity uses its enabled manual server or its native installed plugin namespace at this endpoint',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'oc-agy-server-'));
  try{
    writeFileSync(join(directory,'mcp_config.json'),JSON.stringify({mcpServers:{opencrawl:{url:endpoint}}}));
    const select=(text:string,name:string)=>findSetupConnection('antigravity','agy',api,async args=>args[0]==='mcp'?text:JSON.stringify([{name,enabled:true,path:directory,mcpServers:['opencrawl']}]));
    expect(await select('opencrawl  http  enabled  '+endpoint,scoped)).toEqual({name:'opencrawl',skipLogin:false});
    expect(await select('opencrawl  http  disabled  '+endpoint,'opencrawl')).toEqual({name:'opencrawl_opencrawl',skipLogin:false});
    expect(await select('opencrawl  http  enabled  https://other.example/mcp',scoped)).toEqual({name:scoped+'_opencrawl',skipLogin:false});
    writeFileSync(join(directory,'mcp_config.json'),JSON.stringify({mcpServers:{opencrawl:{url:'https://other.example/mcp'}}}));
    await expect(select('',scoped)).rejects.toMatchObject({code:'NATIVE_MCP_UNAVAILABLE'});
  }finally{rmSync(directory,{recursive:true,force:true});}
});
