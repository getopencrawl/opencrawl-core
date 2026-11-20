import {expect,spyOn,test} from 'bun:test';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {saveSession} from '../src/session.ts';
import {workloadPluginCommand} from '../src/workload-plugin-command.ts';

test('recording export requires first-turn credentials in the same setup command',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-recording-export-')),api='https://recording.example';
  const org='org-0123456789abcdef0123456789abcdef',key='cog_recording_fixture';
  const original={...process.env},calls:unknown[]=[],output:string[]=[];
  const stdout=spyOn(process.stdout,'write').mockImplementation(value=>{output.push(String(value));return true;});
  const respond=async(target:RequestInfo|URL,init?:RequestInit)=>{
    expect(String(target)).toBe(api+'/api/cli/workloads/devin/event-grant');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer human-sign-in');
    const body=JSON.parse(String(init?.body));
    calls.push(body);
    return body.serviceKey===key
      ?Response.json({data:{recording:true,organizationId:org,scope:'organization'}})
      :Response.json({error:{code:'DEVIN_RECORDING_CREDENTIAL_REQUIRED'}},{status:412});
  };
  const fetcher=spyOn(globalThis,'fetch').mockImplementation(Object.assign(respond,{preconnect:fetch.preconnect}));
  try {
    process.env.OPENCRAWL_CONFIG_HOME=dir;
    delete process.env.OPENCRAWL_AUTH;
    saveSession(api,{auth:{clientId:'fixture',deviceAuthorizationEndpoint:api+'/device',tokenEndpoint:api+'/token'},
      accessToken:'human-sign-in',refreshToken:'human-refresh',expiresAt:Date.now()+300000});
    const bundle=join(dir,'bundle');
    const args=['bundle','--api',api,'--directory',bundle,'--command','/bin/opencrawl','--config-home','/home/ubuntu/.config','--json','--recording'];
    expect(await workloadPluginCommand([...args,'on'])).not.toBe(0);
    expect(output.at(-1)).toContain('DEVIN_RECORDING_CREDENTIAL_REQUIRED');
    expect(existsSync(bundle)).toBe(false);
    expect(await workloadPluginCommand([...args,'off'])).toBe(0);
    expect(calls).toHaveLength(1);
    expect(await workloadPluginCommand([...args,'on','--key-stdin'],Readable.from([key]))).toBe(0);
    expect(calls).toEqual([{action:'prepareRecording'},{action:'prepareRecording',serviceKey:key}]);
    expect(output.join('')).not.toContain(key);
    for(const file of readdirSync(bundle,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile())){
      expect(readFileSync(join(file.parentPath,file.name),'utf8')).not.toContain(key);
    }
  } finally {
    fetcher.mockRestore();stdout.mockRestore();
    for(const name of Object.keys(process.env))if(!(name in original))delete process.env[name];
    Object.assign(process.env,original);
    rmSync(dir,{recursive:true,force:true});
  }
});
