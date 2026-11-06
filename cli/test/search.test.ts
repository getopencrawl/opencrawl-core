import {test, expect} from 'bun:test';
import {searchInput, searchWorkspace, formatSearch, fetchInput, fetchWorkspace, formatFetch} from '../src/search.ts';

test('search command validates filters before sending and never accepts a scope or DSL', () => {
  expect(searchInput(' incident filters ', {})).toEqual({query:'incident filters',source:'all',match:'any',limit:10});
  for (const [query, options] of [['',{}],['x',{source:'bad'}],['x',{match:'bad'}],['x',{limit:'41'}],['x',{'session-id':'s'}]] as const) expect(()=>searchInput(query,options)).toThrow();
});
test('fetch command validates paging and uses the authenticated fetch endpoint', async () => {
  expect(fetchInput('sessions:abc',{})).toEqual({id:'sessions:abc',offset:0,length:6000});
  expect(searchInput('x',{'no-dedupe':true})).toMatchObject({dedupe:false});
  for (const [id,options] of [['../../bad',{}],['sessions:x',{offset:-1}],['sessions:x',{length:16001}],['sessions:x',{'content-version':'bad'}]] as const) expect(()=>fetchInput(id,options)).toThrow();
  const saved=process.env.OPENCRAWL_TOKEN;process.env.OPENCRAWL_TOKEN='local-only-secret';
  try {
    const data={id:'sessions:abc',title:'Session',text:'source',provenance:{sessionId:'s'},offset:0,totalChars:20,nextOffset:6,version:'a'.repeat(64)};
    const fetcher=(async(url:any,init:any)=>{expect(url).toBe('http://127.0.0.1:8093/api/search/fetch');expect(init.headers.authorization).toBe('Bearer local-only-secret');return Response.json({schemaVersion:1,data});}) as typeof fetch;
    expect(await fetchWorkspace('http://127.0.0.1:8093',{id:'sessions:abc'},fetcher)).toEqual(data);
    expect(formatFetch(data)).toContain('--offset 6 --content-version');
    for(const status of [404,409]) await expect(fetchWorkspace('http://127.0.0.1:8093',{id:'sessions:abc'},(async()=>Response.json({}, {status})) as unknown as typeof fetch)).rejects.toThrow();
  } finally {if(saved===undefined)delete process.env.OPENCRAWL_TOKEN;else process.env.OPENCRAWL_TOKEN=saved;}
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
