import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {zstdCompressSync} from 'node:zlib';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';
import {createSessionIngest} from '../../dist/src/sessions/ingest.mjs';

test('CLI imports only the pinned, eligible project sessions across native clients and archives',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'oc-history-'));
  const owner={tenantId:'tenant',userId:'user'};
  const batches:any[]=[];
  const ingest=createSessionIngest({store:createLocalSessionStore(join(dir,'store'))});
  let requests=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
    requests++;
    if(new URL(req.url).pathname==='/api/sessions/identity')return Response.json({data:{principal:owner}});
    const batch=await req.json();batches.push(batch);
    return Response.json({data:await ingest.putBatch(owner,batch)});
  }});
  try{
    const api=server.url.origin,config=join(dir,'config'),capture=join(config,'opencrawl','capture');
    const roots={'claude-code':join(dir,'claude'),codex:join(dir,'codex')};
    const project=join(dir,'app'),claude=join(roots['claude-code'],'projects','native'),codex=join(roots.codex,'archived_sessions');
    for(const path of [capture,claude,codex,project])mkdirSync(path,{recursive:true});
    const settings={schemaVersion:1,api,owner,installationId:'test',installedAt:'2026-01-01',roots,command:[],exclusions:{projects:[],sessions:['private']}};
    const save=()=>writeFileSync(join(capture,'config.json'),JSON.stringify(settings));
    const time=(day:number)=>new Date(Date.UTC(2026,0,day)).toISOString();
    const msg=(id:string,day:number,cwd=project,content=id)=>JSON.stringify({type:'user',message:{role:'user',content},sessionId:id,cwd,timestamp:time(day)})+'\n';
    const path=(id:string)=>join(claude,id+'.jsonl');
    const add=(id:string,day:number,cwd=project)=>writeFileSync(path(id),msg(id,day,cwd));
    const cli=async(...args:string[])=>{
      const proc=Bun.spawn([process.execPath,join(import.meta.dir,'../src/cli.ts'),...args,'--json'],{env:{...process.env,OPENCRAWL_CONFIG_HOME:config,OPENCRAWL_API_URL:api,OPENCRAWL_SESSIONS_TOKEN:'test-local',CLAUDE_CONFIG_DIR:roots['claude-code'],CODEX_HOME:roots.codex},stdout:'pipe',stderr:'pipe'});
      const out=await new Response(proc.stdout).json();
      expect((await proc.exited)===0).toBe(!out.error);
      return out;
    };
    add('private',20);add('other',21,project+'-sibling');add('old',1);
    add('middle',3);add('first',6,join(project,'child'));
    writeFileSync(path('mirror'),msg('middle',3));
    writeFileSync(path('two-ids'),msg('bad-a',23)+msg('bad-b',23));
    writeFileSync(path('two-projects'),msg('bad-c',24)+msg('bad-c',25,project+'-sibling'));
    const archive=[{type:'session_meta',payload:{id:'archived',cwd:project}},{type:'response_item',timestamp:time(5),payload:{type:'message',role:'user',content:'archived'}}];
    writeFileSync(join(codex,'rollout.jsonl.zst'),zstdCompressSync(archive.map(r=>JSON.stringify(r)+'\n').join('')));
    const list=async(n:string)=>(await cli('history','list','--project',project,'--limit',n));
    const apply=async(id:string)=>(await cli('history','import','--yes','--plan-id',id));
    expect((await list('2')).data.planId).toBeNull();save();
    expect((await list('0')).error.code).toBe('INVALID_USAGE');
    expect((await cli('collect','backfill','--limit','2','--yes')).error.code).toBe('INVALID_USAGE');
    const plan=(await list('3')).data;
    expect(plan.sessions.map((s:any)=>s.sessionId)).toEqual(['first','archived','middle']);
    expect(requests).toBe(0);
    add('later',30);
    appendFileSync(path('first'),msg('first',29,project,'after-preview'));
    const result=(await apply(plan.planId)).data;
    expect(result.processed).toBe(3);
    expect(new Set(batches.map(b=>b.sessionId))).toEqual(new Set(['first','archived','middle']));
    expect(JSON.stringify(batches)).not.toContain('after-preview');
    expect((await apply(plan.planId)).data.uploaded).toBe(0);
    const next=(await list('2')).data;
    expect(next.sessions.map((s:any)=>s.sessionId)).toEqual(['later','first']);
    const count=batches.length;
    settings.exclusions.sessions.push('later');save();
    expect((await apply(next.planId)).error.code).toBe('HISTORY_PLAN_CHANGED');
    settings.exclusions.sessions.pop();save();
    writeFileSync(path('first'),msg('first',6,join(project,'child'),'other bytes')+msg('first',29,project,'after-preview'));
    expect((await apply(next.planId)).error.code).toBe('HISTORY_PLAN_CHANGED');
    settings.owner={...owner,tenantId:'other'};save();
    expect((await apply(plan.planId)).error.code).toBe('HISTORY_PLAN_CHANGED');
    expect(batches.length).toBe(count);
    expect((await cli('history','list','--project',join(dir,'absent'),'--limit','5')).data.selected).toBe(0);
  }finally{server.stop(true);rmSync(dir,{recursive:true,force:true});}
},30000);

test('snapshot parsing refuses a rewritten block before forwarding its bytes',async()=>{
  const {historyBlocks,historyLineChunks}=await import('../src/capture/history-snapshot.ts');
  const bytes=Buffer.alloc(1024*1024+104,65);bytes[42]=10;bytes[bytes.length-1]=10;
  const digests:string[]=[];
  const source=async function*(){for(let i=0;i<bytes.length;i+=65536)yield bytes.subarray(i,i+65536);};
  for await(const _ of historyBlocks(source(),d=>digests.push(d))){}
  expect(digests).toHaveLength(2);
  bytes[bytes.length-2]=66;
  const approved=historyBlocks(source(),(digest,i)=>{if(digest!==digests[i])throw new Error('changed');});
  const read=historyLineChunks(approved);
  expect((await read.next()).value?.length).toBe(43);
  await expect(read.next()).rejects.toThrow('changed');
});
