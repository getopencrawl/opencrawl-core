import {test, expect} from 'bun:test';
import {createWorkspaceTokenProvider, workspaceIdentityEnabled} from '../src/workspace-identity.ts';
import {withEnvironmentTokenOrigin} from '../src/environment-token.ts';
import {join} from 'node:path';

const api='https://receiver.example';
const token=(exp:number,nonce:number,aud=api)=>'header.'+Buffer.from(JSON.stringify({iss:'https://api.replicas.dev',aud,exp,nonce})).toString('base64url')+'.signature';
test('workspace helper refreshes expiring and rejected tokens without persisting or sharing destinations',async()=>{
 let time=1000000,calls=0;
 const provider=createWorkspaceTokenProvider({now:()=>time,mint:async aud=>{calls++;return token(time/1000+900,calls,aud);}});
 await withEnvironmentTokenOrigin(api,async()=>{
   const [a,b]=await Promise.all([provider(api),provider(api)]);expect(a).toBe(b);expect(calls).toBe(1);
   expect(await provider(api)).toBe(a);time+=841000;const c=await provider(api);expect(c).not.toBe(a);expect(calls).toBe(2);
   expect(await provider(api,c)).not.toBe(c);expect(calls).toBe(3);
   await expect(provider('https://other.example')).rejects.toMatchObject({code:'TOKEN_DESTINATION_MISMATCH'});expect(calls).toBe(3);
 });
});
test('workload CLI refuses human login and credential management before starting OAuth',async()=>{
 for(const args of [['login'],['token','create']]){
  const env:NodeJS.ProcessEnv={...process.env,OPENCRAWL_AUTH:'replicas-workspace',OPENCRAWL_NO_UPDATE:'1'};
  delete env.OPENCRAWL_TOKEN;delete env.OPENCRAWL_SESSIONS_TOKEN;
  const child=Bun.spawn([process.execPath,join(import.meta.dir,'../src/cli.ts'),...args,'--json'],{env,stdout:'pipe',stderr:'pipe'});
  const [output,errors,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(status).toBe(2);expect(JSON.parse(output).error.code).toBe('WORKLOAD_ACCOUNT_ACTION');expect(errors).not.toContain('Open https://');
 }
});
test('invalid or failed workspace credentials never become fallback human credentials',async()=>{
 await withEnvironmentTokenOrigin(api,async()=>{
  for(const mint of [async()=>token(1,1),async()=>token(Date.now()/1000+900,1,'https://other.example'),async()=> 'bad']){
   await expect(createWorkspaceTokenProvider({mint})(api)).rejects.toMatchObject({code:'WORKSPACE_IDENTITY_INVALID'});
  }
  await expect(createWorkspaceTokenProvider({mint:async()=>{throw new Error('secret provider output');}})(api)).rejects.toMatchObject({code:'WORKSPACE_IDENTITY_UNAVAILABLE'});
 });
 const before={...process.env};
 try{
  process.env.OPENCRAWL_AUTH='replicas-workspace';delete process.env.OPENCRAWL_TOKEN;delete process.env.OPENCRAWL_SESSIONS_TOKEN;
  expect(workspaceIdentityEnabled()).toBe(true);process.env.OPENCRAWL_TOKEN='shared-human';expect(()=>workspaceIdentityEnabled()).toThrow('Remove shared human tokens');
 }finally{for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);}
});
