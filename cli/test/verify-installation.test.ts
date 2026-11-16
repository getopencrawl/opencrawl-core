import {test,expect} from 'bun:test';
import {verifyInstallation,formatInstallationVerification} from '../src/verify-installation.ts';
import type {SetupClientStatus} from '../../src/setup/types.mjs';

const api='http://127.0.0.1:8093',input={installationId:'test-installation',client:'codex'};
const pending:SetupClientStatus={client:'codex',installed:true,forward:true,history:'skip',historyProgress:{state:'not_started',completed:0},hookTrust:'pending',mcp:{state:'pending'},proof:{state:'waiting_capture',id:'a'.repeat(32),marker:'opencrawlverify'+('a'.repeat(32))},humanTasks:[]};
async function environment(run:()=>Promise<void>) {
  const before={token:process.env.OPENCRAWL_TOKEN,api:process.env.OPENCRAWL_API_URL};
  process.env.OPENCRAWL_TOKEN='local-test-credential';process.env.OPENCRAWL_API_URL=api;
  try{await run();}finally{if(before.token===undefined)delete process.env.OPENCRAWL_TOKEN;else process.env.OPENCRAWL_TOKEN=before.token;if(before.api===undefined)delete process.env.OPENCRAWL_API_URL;else process.env.OPENCRAWL_API_URL=before.api;}
}
test('verification asks server for one scoped proof and preserves independent MCP and history states',()=>environment(async()=>{
  const fetcher=(async(url:unknown,init:RequestInit)=>{
    expect(url).toBe(api+'/api/setup/verify');expect(init.method).toBe('POST');expect(init.redirect).toBe('error');expect(JSON.parse(String(init.body))).toEqual(input);
    expect((init.headers as Record<string,string>).authorization).toBe('Bearer local-test-credential');
    return Response.json({schemaVersion:1,data:pending});
  }) as typeof fetch;
  const result=await verifyInstallation(api,input,fetcher);expect(result.proof.state).toBe('waiting_capture');expect(result.mcp.state).toBe('pending');
  expect(formatInstallationVerification(result)).toContain('MCP: pending');
  const searchable={...pending,proof:{state:'verified' as const,id:'a',sessionId:'native',eventId:'event',passageId:'sessions:p',verifiedAt:new Date().toISOString()}};
  expect(formatInstallationVerification(searchable)).toContain('A new codex session is searchable');expect(formatInstallationVerification(searchable)).toContain('MCP: pending');
}));
test('verification rejects incomplete or other-client evidence and sanitizes service failures',()=>environment(async()=>{
  for(const data of [{...pending,client:'cursor'},{...pending,proof:{state:'verified'}},{...pending,mcp:{state:'logged_in'}}]) {
    await expect(verifyInstallation(api,input,(async()=>Response.json({schemaVersion:1,data})) as unknown as typeof fetch)).rejects.toThrow('invalid installation proof');
  }
  for(const status of [400,401,403,404,409,503]) {
    try{await verifyInstallation(api,input,(async()=>Response.json({error:{message:'private underlying error'}},{status})) as unknown as typeof fetch);throw new Error('unexpected success');}
    catch(error){expect((error as Error).message).not.toContain('private underlying error');}
  }
}));
test('verification validates client and installation before any network call',async()=>{
  let calls=0;const fetcher=(async()=>{calls++;throw new Error('must not call');}) as unknown as typeof fetch;
  for(const value of [{installationId:'../../scope',client:'codex'},{installationId:'x',client:'other'},{...input,tenantId:'forged'}])await expect(verifyInstallation(api,value,fetcher)).rejects.toThrow();
  expect(calls).toBe(0);
});
