import {test,expect} from 'bun:test';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {scopeKey,type SetupState} from '../src/setup/state.ts';

test('standalone verification infers only the authenticated local installation and preserves explicit IDs',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-setup-verification-')),requests:unknown[]=[];let tenantId='fixture-team';
 const row={client:'codex',installed:true,forward:true,history:'skip',historyProgress:{state:'not_started',completed:0},hookTrust:'pending',mcp:{state:'pending'},proof:{state:'waiting_capture'},humanTasks:[]};
 const server=createServer(async(req,res)=>{
  let data:unknown;
  if(req.url==='/api/setup')data={scope:{tenantId,userId:'fixture-user'},firstWin:null,installations:[]};
  else if(req.url==='/api/setup/verify'){const chunks=[];for await(const chunk of req)chunks.push(chunk);requests.push(JSON.parse(Buffer.concat(chunks).toString()));data=row;}
  else {res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const api='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const config=join(dir,'config'),scope={api,tenantId,userId:'fixture-user'},state:SetupState={schemaVersion:1,scope,installationId:'fixture-local-installation',acceptedAt:new Date().toISOString(),selections:{plugins:{codex:true},forward:{codex:true},history:{codex:false}}};
 const root=join(config,'opencrawl','setup');mkdirSync(root,{recursive:true});writeFileSync(join(root,scopeKey(scope)+'.json'),JSON.stringify(state));
 const run=async(extra:string[]=[])=>{const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../src/cli.ts'),'verify-installation','--client','codex','--json','--api',api,...extra],{env:{...process.env,HOME:dir,USERPROFILE:dir,OPENCRAWL_CONFIG_HOME:config,OPENCRAWL_API_URL:api,OPENCRAWL_NO_UPDATE:'1',OPENCRAWL_TOKEN:'fixture-read-token-01234567890'},stdout:'pipe',stderr:'pipe'});const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {stdout,stderr,code};};
 try{
  const inferred=await run();expect(inferred.code).toBe(0);expect(inferred.stderr).toBe('');expect(JSON.parse(inferred.stdout).data).toEqual(row);expect(requests).toEqual([{installationId:state.installationId,client:'codex'}]);
  const explicit=await run(['--installation-id','fixture-explicit-installation']);expect(explicit.code).toBe(0);expect(requests[1]).toEqual({installationId:'fixture-explicit-installation',client:'codex'});
  tenantId='another-workspace';const mismatch=await run();expect(mismatch.code).toBe(64);expect(mismatch.stderr).toBe('');const failure=JSON.parse(mismatch.stdout);expect(failure).toMatchObject({schemaVersion:1,error:{code:'INVALID_USAGE'}});expect(failure.error.message).toContain(process.execPath);expect(failure.error.message).toContain(resolve(import.meta.dir,'../src/cli.ts'));expect(failure.error.message).toContain('setup --api '+api);expect(failure.error.message).toContain('setup verify --api '+api+' --client CLIENT');expect(requests).toHaveLength(2);
  const multiple=await run(['--client','cursor']);expect(multiple.code).toBe(64);expect(requests).toHaveLength(2);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
},15000);
