import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {environmentToken, withEnvironmentTokenOrigin} from '../src/environment-token.ts';
import {searchWorkspace} from '../src/search.ts';
import {boardRequest} from '../src/board.ts';
import {request, captureHook, flushCaptureWork, readCaptureConfig, captureStatus} from '../src/capture/runtime.ts';
import {installCapture} from '../src/capture/install.ts';
import {hash} from '../src/capture/parse.ts';

test('environment tokens default to cloud and reject a different deployment before network',async()=>{
  const saved={...process.env},directory=mkdtempSync(join(tmpdir(),'token-destination-'));
  const priorFetch=globalThis.fetch;let requests=0;
  globalThis.fetch=(async()=>{requests++;throw new Error('Unexpected network');}) as unknown as typeof fetch;
  try{
    process.env.OPENCRAWL_CONFIG_HOME=directory;
    process.env.OPENCRAWL_TOKEN='fixture-search-secret';
    process.env.OPENCRAWL_SESSIONS_TOKEN='fixture-capture-secret';
    delete process.env.OPENCRAWL_API_URL;
    for(const name of ['OPENCRAWL_TOKEN','OPENCRAWL_SESSIONS_TOKEN'] as const){
      expect(environmentToken(name,'https://app.getopencrawl.com/')).toBe(process.env[name]);
      await withEnvironmentTokenOrigin(undefined,async()=>{
        expect(environmentToken(name,'https://app.getopencrawl.com')).toBe(process.env[name]);
        await Promise.resolve();
        expect(()=>environmentToken(name,'https://saved.example')).toThrow();
      });
    }
    const operations=(api:string)=>[()=>searchWorkspace(api,{query:'fixture'}),
      ()=>boardRequest(api,'directory',{}),()=>request(api,'/api/sessions/identity')];
    for(const operation of operations('https://saved.example'))await expect(operation()).rejects.toMatchObject({code:'TOKEN_DESTINATION_MISMATCH'});
    process.env.OPENCRAWL_API_URL='https://self.example';
    for(const operation of operations('https://app.getopencrawl.com'))await expect(operation()).rejects.toMatchObject({code:'TOKEN_DESTINATION_MISMATCH'});
    expect(requests).toBe(0);
    expect(environmentToken('OPENCRAWL_TOKEN','https://self.example')).toBe('fixture-search-secret');
    await withEnvironmentTokenOrigin('https://selected.example',async()=>{
      expect(environmentToken('OPENCRAWL_TOKEN','https://selected.example')).toBe('fixture-search-secret');
      // Background capture must not send this invocation's token to its saved server.
      await expect(request('https://self.example','/api/sessions/identity')).rejects.toMatchObject({code:'TOKEN_DESTINATION_MISMATCH'});
    });
    expect(environmentToken('OPENCRAWL_TOKEN','https://self.example')).toBe('fixture-search-secret');
    expect(requests).toBe(0);
  }finally{
    globalThis.fetch=priorFetch;
    for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];
    Object.assign(process.env,saved);rmSync(directory,{recursive:true,force:true});
  }
});

test('deferred cloud capture authenticates and uploads with only the sessions token',async()=>{
  const saved={...process.env},directory=mkdtempSync(join(tmpdir(),'cloud-token-capture-'));
  const priorFetch=globalThis.fetch,api='https://app.getopencrawl.com';
  const owner={tenantId:'fixture-team',userId:'fixture-user'},batches:any[]=[];
  const paths:string[]=[];
  try{
    Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(directory,'config'),CLAUDE_CONFIG_DIR:join(directory,'claude'),CODEX_HOME:join(directory,'codex'),CLAUDE_CODE_REMOTE:'true',OPENCRAWL_NO_UPDATE:'1'});
    delete process.env.OPENCRAWL_API_URL;
    delete process.env.OPENCRAWL_TOKEN;
    delete process.env.OPENCRAWL_SESSIONS_TOKEN;
    globalThis.fetch=(async(input:any,init:any)=>{
      const url=new URL(String(input));paths.push(url.pathname);
      expect(url.origin).toBe(api);
      expect(init.redirect).toBe('error');
      expect(init.headers.authorization).toBe('Bearer fixture-upload-only');
      if(url.pathname==='/api/sessions/identity')return Response.json({data:{principal:owner}});
      if(url.pathname==='/api/sessions/batches'){
        batches.push(JSON.parse(init.body));
        return Response.json({data:{stored:true,batchId:hash(init.body)}});
      }
      throw Error('Unexpected cloud request');
    }) as unknown as typeof fetch;
    await withEnvironmentTokenOrigin(undefined,()=>installCapture(api,{deferAuth:true,home:directory,command:[],harnesses:['claude-code']}));
    expect(paths).toEqual([]);
    expect(readCaptureConfig()!.authPending).toBe(true);
    // Secrets arrive after image preparation; the harness invokes hooks without --api.
    process.env.OPENCRAWL_SESSIONS_TOKEN='fixture-upload-only';
    const path=join(directory,'claude','projects','fixture','session.jsonl');
    mkdirSync(join(path,'..'),{recursive:true});
    writeFileSync(path,JSON.stringify({type:'user',uuid:'fixture-message',sessionId:'cloud-session',message:{role:'user',content:'synthetic cloud capture'}})+'\n');
    await withEnvironmentTokenOrigin(undefined,async()=>{
      await captureHook('claude-code',{session_id:'cloud-session',transcript_path:path,hook_event_name:'UserPromptSubmit'});
      await flushCaptureWork();
    });
    expect(batches.length).toBeGreaterThan(0);
    for(const batch of batches)expect(batch).toMatchObject({owner,sessionId:'cloud-session',origin:'cloud'});
    expect(JSON.stringify(batches)).toContain('synthetic cloud capture');
    expect(readCaptureConfig()!.authPending).toBeFalsy();
    expect(captureStatus()).toMatchObject({queued:0,lastUpload:{stored:true}});
    delete process.env.OPENCRAWL_SESSIONS_TOKEN;
    const previousRequests=paths.length;
    await expect(request(api,'/api/sessions/identity')).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    expect(paths).toHaveLength(previousRequests);
  }finally{
    globalThis.fetch=priorFetch;
    for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];
    Object.assign(process.env,saved);rmSync(directory,{recursive:true,force:true});
  }
});
