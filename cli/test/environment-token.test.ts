import {test, expect} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {environmentToken, withEnvironmentTokenOrigin} from '../src/environment-token.ts';
import {searchWorkspace} from '../src/search.ts';
import {boardRequest} from '../src/board.ts';
import {request} from '../src/capture/runtime.ts';

test('environment tokens fail before network without an explicit matching deployment',async()=>{
  const saved={...process.env},directory=mkdtempSync(join(tmpdir(),'token-destination-'));
  const priorFetch=globalThis.fetch;let requests=0;
  globalThis.fetch=(async()=>{requests++;throw new Error('Unexpected network');}) as unknown as typeof fetch;
  try{
    process.env.OPENCRAWL_CONFIG_HOME=directory;
    process.env.OPENCRAWL_TOKEN='fixture-search-secret';
    process.env.OPENCRAWL_SESSIONS_TOKEN='fixture-capture-secret';
    delete process.env.OPENCRAWL_API_URL;
    const operations=[()=>searchWorkspace('https://app.getopencrawl.com',{query:'fixture'}),
      ()=>boardRequest('https://app.getopencrawl.com','directory',{}),
      ()=>request('https://app.getopencrawl.com','/api/sessions/identity')];
    for(const operation of operations)await expect(operation()).rejects.toMatchObject({code:'TOKEN_DESTINATION_REQUIRED'});
    process.env.OPENCRAWL_API_URL='https://self.example';
    for(const operation of operations)await expect(operation()).rejects.toMatchObject({code:'TOKEN_DESTINATION_MISMATCH'});
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
