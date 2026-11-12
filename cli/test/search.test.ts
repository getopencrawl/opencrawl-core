import {test, expect} from 'bun:test';
import {beforeEach, afterEach} from 'bun:test';
import {searchInput, searchWorkspace, formatSearch, fetchInput, fetchWorkspace, formatFetch} from '../src/search.ts';

let priorTokenOrigin:string|undefined;
beforeEach(()=>{priorTokenOrigin=process.env.OPENCRAWL_API_URL;});
afterEach(()=>{if(priorTokenOrigin===undefined)delete process.env.OPENCRAWL_API_URL;else process.env.OPENCRAWL_API_URL=priorTokenOrigin;});

test('search command validates filters before sending and never accepts a scope or DSL', () => {
  expect(searchInput(' incident filters ', {})).toEqual({query:'incident filters',source:'all',match:'any',limit:10});
  for (const [query, options] of [['',{}],['x',{source:'bad'}],['x',{match:'bad'}],['x',{limit:'41'}],['x',{'session-id':'s'}]] as const) expect(()=>searchInput(query,options)).toThrow();
});
test('fetch command validates paging and uses the authenticated fetch endpoint', async () => {
  expect(fetchInput('sessions:abc',{})).toEqual({id:'sessions:abc',offset:0,length:6000});
  expect(searchInput('x',{'no-dedupe':true})).toMatchObject({dedupe:false});
  for (const [id,options] of [['../../bad',{}],['sessions:x',{offset:-1}],['sessions:x',{length:16001}],['sessions:x',{'content-version':'bad'}]] as const) expect(()=>fetchInput(id,options)).toThrow();
  const saved=process.env.OPENCRAWL_TOKEN;process.env.OPENCRAWL_API_URL='http://127.0.0.1:8093';process.env.OPENCRAWL_TOKEN='local-only-secret';
  try {
    const data={id:'sessions:abc',title:'Session',text:'source',provenance:{sessionId:'s'},offset:0,totalChars:20,nextOffset:6,version:'a'.repeat(64)};
    const fetcher=(async(url:any,init:any)=>{expect(url).toBe('http://127.0.0.1:8093/api/search/fetch');expect(init.headers.authorization).toBe('Bearer local-only-secret');return Response.json({schemaVersion:1,data});}) as typeof fetch;
    expect(await fetchWorkspace('http://127.0.0.1:8093',{id:'sessions:abc'},fetcher)).toEqual(data);
    expect(formatFetch(data)).toContain('--offset 6 --content-version');
    for(const status of [404,409]) await expect(fetchWorkspace('http://127.0.0.1:8093',{id:'sessions:abc'},(async()=>Response.json({}, {status})) as unknown as typeof fetch)).rejects.toThrow();
  } finally {if(saved===undefined)delete process.env.OPENCRAWL_TOKEN;else process.env.OPENCRAWL_TOKEN=saved;}
});
test('self-host query returns versioned evidence, reports incomplete coverage and sanitizes failures', async () => {
  const saved=process.env.OPENCRAWL_TOKEN;process.env.OPENCRAWL_API_URL='http://127.0.0.1:8093';process.env.OPENCRAWL_TOKEN='local-only-secret';
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


test('agent discovery controls survive the CLI with strict field validation',()=>{
  expect(searchInput(undefined,{order:'newest',facets:'role,harness',select:'title,provenance',role:'assistant',before:'2026-11-01T00:00:00Z','group-by':'session','excerpt-chars':'400'})).toMatchObject({query:'',order:'newest',facets:['role','harness'],select:['title','provenance'],filters:{roles:['assistant'],before:'2026-11-01T00:00:00Z'},groupBy:'session',excerptChars:400});
  expect(searchInput('release',{filters:'{"providers":["github"],"repositories":["org/repo"]}'})).toMatchObject({filters:{providers:['github'],repositories:['org/repo']}});
  expect(searchInput('capture',{source:'sessions',facets:'origin',filters:'{"origins":["desktop","unknown"]}'})).toMatchObject({facets:['origin'],filters:{origins:['desktop','unknown']}});
  for(const filters of ['{"origins":[]}','{"origins":"desktop"}'])expect(()=>searchInput('capture',{filters})).toThrow();
  expect(searchInput('receipts',{source:'sessions','session-id':'chat-a',filters:'{"sessionIds":["chat-a","chat-b"]}'})).toMatchObject({sessionId:'chat-a',filters:{sessionIds:['chat-a','chat-b']}});
  for(const sessionIds of [[],['x'.repeat(201)],Array(21).fill('chat'),'chat'])expect(()=>searchInput('receipts',{filters:JSON.stringify({sessionIds})})).toThrow();
  for(const values of [{filters:'{"tenantId":"foreign"}'},{filters:'[]'},{filters:'{"roles":["anything"]}'},{role:'tool'},{facets:'secret'},{select:'sourceKey'},{'group-by':'tenant'},{after:'2026-12-01T00:00:00Z',before:'2026-11-01T00:00:00Z'}])expect(()=>searchInput('x',values)).toThrow();
  expect(formatSearch({results:[{id:'sessions:x',source:'sessions',title:'Discovery'}],coverage:[],partial:false})).not.toContain('undefined');
});
