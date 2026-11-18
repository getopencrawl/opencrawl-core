import {test,expect} from 'bun:test';
import {identity} from '../src/cli.ts';
import {personalMemoryCommand} from '../src/personal-memory-command.ts';

test('a service-verified workload identity cannot be used to import a human memory',async()=>{
 const saved=process.env.OPENCRAWL_TOKEN,auth=process.env.OPENCRAWL_AUTH;
 process.env.OPENCRAWL_TOKEN='test-personal-or-workload';delete process.env.OPENCRAWL_AUTH;
 try{
  const me=Object.assign(async()=>Response.json({schemaVersion:1,data:{credential:'workspace-identity',workload:{kind:'shared'},
    user:{id:'shared'},workspace:{id:'single-tenant',name:null}}}),{preconnect:()=>{}}) as typeof fetch;
  const identify:typeof identity=(api,_fetcher,token)=>identity(api,me,token);
  await expect(personalMemoryCommand(['scan','--api','https://self-host.example'],identify)).rejects.toMatchObject({code:'AUTH_REQUIRED'});
 }finally{
  if(saved===undefined)delete process.env.OPENCRAWL_TOKEN;else process.env.OPENCRAWL_TOKEN=saved;
  if(auth===undefined)delete process.env.OPENCRAWL_AUTH;else process.env.OPENCRAWL_AUTH=auth;
 }
});
