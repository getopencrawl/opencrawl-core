import {test, expect} from 'bun:test';
import {searchInput, searchWorkspace, formatSearch} from '../src/search.ts';

test('search command validates filters before sending and never accepts a scope or DSL', () => {
  expect(searchInput(' incident filters ', {})).toEqual({query:'incident filters',source:'all',match:'any',limit:10});
  for (const [query, options] of [['',{}],['x',{source:'bad'}],['x',{match:'bad'}],['x',{limit:'41'}],['x',{'session-id':'s'}]] as const) expect(()=>searchInput(query,options)).toThrow();
});
test('self-host query returns versioned evidence, reports incomplete coverage and sanitizes failures', async () => {
  const saved=process.env.OPENCRAWL_TOKEN;process.env.OPENCRAWL_TOKEN='local-only-secret';
  try {
    const data={results:[{id:'sessions:x',title:'Session s',text:'evidence',provenance:{sessionId:'s'}}],coverage:[{source:'sessions',state:'ready'},{source:'connectors',state:'unavailable'}],partial:true,next:null};
    const fetcher=(async(url:any,init:any)=>{expect(url).toBe('http://127.0.0.1:8093/api/search');expect(init.redirect).toBe('error');expect(init.headers.authorization).toBe('Bearer local-only-secret');expect(JSON.parse(init.body)).toEqual({query:'evidence'});return Response.json({schemaVersion:1,data});}) as typeof fetch;
    expect(await searchWorkspace('http://127.0.0.1:8093',{query:'evidence'},fetcher)).toEqual(data);
    expect(formatSearch(data)).toContain('incomplete');
    for(const status of [401,403,400,503]) {
      const bad=(async()=>Response.json({error:{message:'PRIVATE_SECRET'}},{status})) as unknown as typeof fetch;
      try {await searchWorkspace('http://127.0.0.1:8093',{query:'x'},bad);throw new Error('unexpected success');} catch(error:any) {expect(error.message).not.toContain('PRIVATE_SECRET');expect(error.code).toBeDefined();}
    }
  } finally {if(saved===undefined)delete process.env.OPENCRAWL_TOKEN;else process.env.OPENCRAWL_TOKEN=saved;}
});
