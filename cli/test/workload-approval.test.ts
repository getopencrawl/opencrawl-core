import {test,expect} from 'bun:test';
import {existsSync,mkdtempSync,readFileSync,rmSync,statSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {approveWorkload} from '../src/workload-approval.ts';
import {saveSession} from '../src/session.ts';

const api='https://approval.example',code='a'.repeat(64);
const issued=()=>Response.json({schemaVersion:1,data:{code,workspaceId:'org_fixture',expiresAt:new Date(Date.now()+1800000).toISOString()}});
const signIn=(origin=api)=>saveSession(origin,{auth:{clientId:'fixture',deviceAuthorizationEndpoint:origin+'/device',tokenEndpoint:origin+'/token'},accessToken:'human-sign-in',refreshToken:'human-refresh',expiresAt:Date.now()+300000});
async function isolated(run:(dir:string)=>Promise<void>){
  const saved={...process.env},dir=mkdtempSync(join(tmpdir(),'opencrawl-approval-'));
  try{process.env.OPENCRAWL_CONFIG_HOME=dir;delete process.env.OPENCRAWL_AUTH;delete process.env.OPENCRAWL_TOKEN;delete process.env.OPENCRAWL_SESSIONS_TOKEN;await run(dir);}
  finally{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});}
}
const service=(reply:(url:string,init:RequestInit)=>Response|Promise<Response>)=>(async(input:string|URL|Request,init?:RequestInit)=>reply(String(input),init??{})) as typeof fetch;

test('admin approval uses saved sign-in and emits only the private file path',()=>isolated(async dir=>{
  await signIn();process.env.OPENCRAWL_TOKEN='environment-not-authority';
  const file=join(dir,'approval'),requests:string[]=[];
  const result=await approveWorkload(api,file,service((url,init)=>{
    requests.push(url);expect(init.method).toBe('POST');expect(init.redirect).toBe('error');expect(init.body).toBe('{}');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer human-sign-in');return issued();
  }));
  expect(requests).toEqual([api+'/api/cli/workloads/devin/approval']);
  expect(result).toMatchObject({api,provider:'devin',workspaceId:'org_fixture',codeFile:file});
  expect(JSON.stringify(result)).not.toContain(code);expect(readFileSync(file,'utf8')).toBe(code+'\n');
  if(process.platform!=='win32')expect(statSync(file).mode&0o777).toBe(0o600);
}));

test('workload identity, missing human login, existing files and symlinks cannot issue approval',()=>isolated(async dir=>{
  let calls=0;const fetcher=service(()=>{calls++;return issued();}),file=join(dir,'approval');
  process.env.OPENCRAWL_TOKEN='environment-only';
  await expect(approveWorkload(api,file,fetcher)).rejects.toMatchObject({code:'AUTH_REQUIRED'});expect(existsSync(file)).toBe(false);
  await signIn();
  for(const mode of ['devin-cloud','replicas-workspace']){
    process.env.OPENCRAWL_AUTH=mode;
    await expect(approveWorkload(api,file,fetcher)).rejects.toMatchObject({code:'HUMAN_SIGN_IN_REQUIRED'});expect(existsSync(file)).toBe(false);
  }
  delete process.env.OPENCRAWL_AUTH;writeFileSync(file,'preserve');
  await expect(approveWorkload(api,file,fetcher)).rejects.toMatchObject({code:'CODE_FILE_ERROR'});expect(readFileSync(file,'utf8')).toBe('preserve');
  if(process.platform!=='win32'){
    symlinkSync(file,join(dir,'link'));
    await expect(approveWorkload(api,join(dir,'link'),fetcher)).rejects.toMatchObject({code:'CODE_FILE_ERROR'});
  }
  expect(calls).toBe(0);
}));

test('a rejected sign-in refreshes once before issuing approval',()=>isolated(async dir=>{
  await signIn();let calls=0,refreshes=0;
  await approveWorkload(api,join(dir,'approval'),service((url,init)=>{
    if(url===api+'/token'){refreshes++;return Response.json({access_token:'renewed-human',refresh_token:'renewed-refresh',expires_in:300});}
    calls++;
    if(calls===1)return new Response(null,{status:401});
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer renewed-human');return issued();
  }));
  expect(calls).toBe(2);expect(refreshes).toBe(1);
}));

test('failures and malformed replies never expose provider text or leave a code file',()=>isolated(async dir=>{
  await signIn();const file=join(dir,'approval');
  for(const status of [403,404,405,500]){
    await expect(approveWorkload(api,file,service(()=>new Response('private provider detail '+code,{status})))).rejects.not.toThrow(code);
    expect(existsSync(file)).toBe(false);
  }
  for(const response of [new Response(code),new Response('x'.repeat(4097)),Response.json({schemaVersion:1,data:{code,workspaceId:'org_fixture',expiresAt:'2000-01-01'}}),Response.json({schemaVersion:1,data:{code:'wrong',workspaceId:'org_fixture',expiresAt:'2030-01-01'}})]){
    await expect(approveWorkload(api,file,service(()=>response))).rejects.toMatchObject({code:'WORKLOAD_PROTOCOL_ERROR'});expect(existsSync(file)).toBe(false);
  }
  await expect(approveWorkload(api,file,service(()=>{throw Error(code);}))).rejects.not.toThrow(code);expect(existsSync(file)).toBe(false);
}));

test('a replaced destination is preserved and never receives the approval',()=>isolated(async dir=>{
  await signIn();
  // Exercise rapid file-ID allocation and empty replacements as well as content
  // changes; ownership cannot depend on rounded IDs or replacement length.
  for(let i=0;i<32;i++){
    const file=join(dir,'approval-'+i),replacement=i%2?'replacement':'';
    await expect(approveWorkload(api,file,service(()=>{unlinkSync(file);writeFileSync(file,replacement);return issued();}))).rejects.toMatchObject({code:'CODE_FILE_ERROR'});
    expect(readFileSync(file,'utf8')).toBe(replacement);
  }
}));

test('CLI dispatch requires an explicit provider, origin and code file',()=>isolated(async dir=>{
  const run=async(args:string[])=>{
    const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../src/cli.ts'),'workload','approve',...args,'--json'],{env:{...process.env,OPENCRAWL_CONFIG_HOME:dir,OPENCRAWL_NO_UPDATE:'1'},stdout:'pipe',stderr:'pipe'});
    const [out,err,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect(out+err).not.toContain(code);return {status,body:JSON.parse(out)};
  };
  for(const args of [[],['--provider','replicas','--api',api,'--code-file',join(dir,'a')],['--provider','devin','--code-file',join(dir,'a')]]){
    const result=await run(args);expect(result.status).toBe(64);expect(result.body.error.code).toBe('INVALID_USAGE');
  }
  const result=await run(['--provider','devin','--api',api,'--code-file',join(dir,'a')]);expect(result.status).toBe(2);expect(result.body.error.code).toBe('AUTH_REQUIRED');
}));

test('source and bundled CLI write the approval without printing its capability',()=>isolated(async dir=>{
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
    if(new URL(request.url).pathname!=='/api/cli/workloads/devin/approval'||request.headers.get('authorization')!=='Bearer human-sign-in')return new Response(null,{status:401});
    return issued();
  }});
  try{
    const origin=server.url.origin;await signIn(origin);
    const source=resolve(import.meta.dir,'../src/cli.ts'),bundle=join(dir,'cli.js');
    const built=await Bun.build({entrypoints:[source],target:'bun',outdir:dir});expect(built.success).toBe(true);
    for(const [index,entry] of [source,bundle].entries()){
      const file=join(dir,'code-'+index),child=Bun.spawn([process.execPath,entry,'workload','approve','--provider','devin','--api',origin,'--code-file',file,'--json'],{env:{...process.env,OPENCRAWL_NO_UPDATE:'1'},stdout:'pipe',stderr:'pipe'});
      const [out,err,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      expect(status).toBe(0);expect(out+err).not.toContain(code);expect(out+err).not.toContain('human-sign-in');
      expect(JSON.parse(out).data).toMatchObject({api:origin,provider:'devin',codeFile:file,workspaceId:'org_fixture'});
      expect(readFileSync(file,'utf8')).toBe(code+'\n');
    }
  }finally{await server.stop(true);}
}));
