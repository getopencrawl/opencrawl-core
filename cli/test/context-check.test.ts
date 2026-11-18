import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {checkEvent,checkOutput,hash,checkText,type CheckHarness} from '../src/context-check-events.ts';
import {CheckStore,saveCheckSettings,checkBinding,type CheckInput} from '../src/context-check-state.ts';
import {suggestionEventsSchema} from '../../src/search/suggestion-events.mts';
import {flushSuggestionEvents} from '../src/context-suggestion-telemetry.ts';
import {requestCheck,formatCheck} from '../src/context-check.ts';
import {setupPluginFiles,setupPluginIdentity} from '../src/setup/plugins.ts';
import {sessionFile} from '../src/session.ts';
import type {CaptureConfig} from '../src/capture/runtime.ts';

const cli=resolve(import.meta.dir,'../src/cli.ts');
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
function fixture(harness:CheckHarness='codex',api='https://fixture.example'){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'opencrawl-check-'))),configHome=join(home,'profile'),previous=process.env.OPENCRAWL_CONFIG_HOME;
  process.env.OPENCRAWL_CONFIG_HOME=configHome;
  const identity=setupPluginIdentity(api),nativeRoot=join(home,'plugin'),binding={api,client:harness,pluginName:identity.name,configHome,nativeRoot};
  const config:CaptureConfig={schemaVersion:1,hookOwnership:'plugin',api,installationId:'fixture-install',owner:{tenantId:'tenant-a',userId:'user-a'},harnesses:[],roots:{codex:join(home,'codex'),'claude-code':join(home,'claude'),antigravity:join(home,'gemini')},installedAt:new Date().toISOString(),command:[process.execPath,cli]};
  const write=(path:string,value:unknown)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==='string'?value:json(value));};
  const files=setupPluginFiles(harness,api,{command:[process.execPath,cli],configHome}),digest=hash(json(files));
  for(const [name,text] of Object.entries(files))write(join(nativeRoot,name),text);
  write(join(nativeRoot,'.opencrawl-setup-plugin.json'),{schemaVersion:2,...binding,digest,files:Object.fromEntries(Object.entries(files).map(([name,text])=>[name,hash(text)]))});
  write(join(configHome,'opencrawl/setup-plugins',harness,identity.key,'installed.json'),{schemaVersion:2,...binding,digest});
  const configFile=join(configHome,'opencrawl/capture/config.json');write(configFile,config);
  write(sessionFile(api),{auth:{clientId:'fixture',tokenEndpoint:api+'/token'},accessToken:'fixture-token',refreshToken:'unused-refresh',expiresAt:Date.now()+3600000});
  const settings=saveCheckSettings(checkBinding(config,api),[harness]);
  const env:NodeJS.ProcessEnv={...process.env,OPENCRAWL_CONFIG_HOME:configHome,OPENCRAWL_PLUGIN_API:api,OPENCRAWL_PLUGIN_CLIENT:harness,OPENCRAWL_PLUGIN_NAME:identity.name,OPENCRAWL_PLUGIN_ROOT:nativeRoot};
  for(const key of ['OPENCRAWL_TOKEN','OPENCRAWL_SESSIONS_TOKEN','OPENCRAWL_AUTH','OPENCRAWL_API_URL'])delete env[key];
  const run=async(event:unknown,native=false)=>{
    const child=Bun.spawn(native&&process.platform!=='win32'?['/bin/sh',join(nativeRoot,'scripts/opencrawl-hook.sh'),'suggest']:[process.execPath,cli,...(native?['plugin-hook','--root',nativeRoot,'--action','suggest']:['context-suggestions','hook','--harness',harness,'--api',api])],{env:native?{...env,OPENCRAWL_CONFIG_HOME:'/unrelated',OPENCRAWL_TOKEN:'unrelated-token',OPENCRAWL_API_URL:'https://unrelated.example'}:env,stdin:new Blob([JSON.stringify(event)]),stdout:'pipe',stderr:'pipe'});
    const timeout=setTimeout(()=>child.kill(),5000);
    try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect({code,err}).toEqual({code:0,err:''});return out;}finally{clearTimeout(timeout);}
  };
  return {home,env,config,configFile,settings,write,run,close:()=>{if(previous===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=previous;rmSync(home,{recursive:true,force:true});}};
}
const prompt=(harness:CheckHarness,id='prompt-1',message='Fix the deployment retry policy')=>harness==='cursor'?{hook_event_name:'beforeSubmitPrompt',conversation_id:'native-session',generation_id:id,prompt:message}:{hook_event_name:'UserPromptSubmit',session_id:'native-session',turn_id:id,prompt_id:id,prompt:message};
const sample={outputTokens:30,results:[{id:'sessions:fixture',title:'Retry decision',text:'Retries use the same request ID.',offset:0,provenance:{role:'user'}}]};

test('native human prompt IDs preserve repeated turns, steering, and imported/subagent exclusions',()=>{
  const f=fixture();try{for(const harness of ['codex','claude-code','cursor','devin'] as const){
    const event=prompt(harness);expect(checkEvent(harness,event,f.config)?.message).toBe(event.prompt);
    expect(checkEvent(harness,prompt(harness,'prompt-2'),f.config)?.eventId).not.toBe(checkEvent(harness,event,f.config)?.eventId);
    expect(checkEvent(harness,{...event,agent_id:'child'},f.config)).toBeUndefined();
    expect(checkEvent(harness,{...event,hook_event_name:'PostModelRequest'},f.config)).toBeUndefined();
    if(harness!=='cursor')expect(checkEvent(harness,{...event,cursor_version:'imported'},f.config)).toBeUndefined();
    expect(checkEvent(harness,{...event,session_id:undefined,conversation_id:undefined},f.config)).toBeUndefined();
  }
  expect(checkEvent('codex',prompt('codex','prompt-1','new steering'),f.config)?.eventId).not.toBe(checkEvent('codex',prompt('codex'),f.config)?.eventId);
  expect(checkEvent('claude-code',{...prompt('claude-code'),prompt_id:undefined},f.config)).toBeUndefined();
  expect(checkOutput('cursor','text')).toEqual({additional_context:'text'});
  expect(checkOutput('antigravity','text')).toEqual({injectSteps:[{ephemeralMessage:'text'}]});
  }finally{f.close();}
});

test('Antigravity bills the explicit human transcript boundary, never a model invocation',()=>{
  const f=fixture('antigravity');try{
    const path=join(f.config.roots.antigravity!,'antigravity','brain','native-session','.system_generated/logs/transcript.jsonl');
    const user=JSON.stringify({type:'USER_INPUT',source:'USER_EXPLICIT',content:'<USER_REQUEST>\nrepeat\n</USER_REQUEST>'})+'\n';
    f.write(path,user);
    const event={hookEventName:'PreInvocation',conversationId:'native-session',lastUserInput:'repeat',transcriptPath:path,invocationNum:0};
    const first=checkEvent('antigravity',event,f.config);expect(first?.message).toBe('repeat');
    f.write(path,user+JSON.stringify({type:'PLANNER_RESPONSE',content:'working'})+'\n');
    expect(checkEvent('antigravity',{...event,invocationNum:5},f.config)?.eventId).toBe(first?.eventId);
    f.write(path,user+user);expect(checkEvent('antigravity',event,f.config)?.eventId).not.toBe(first?.eventId);
    expect(()=>checkEvent('antigravity',{...event,conversationId:'another-session'},f.config)).toThrow();
    expect(()=>checkEvent('antigravity',{...event,transcriptPath:join(f.home,'unrelated')},f.config)).toThrow();
    f.write(path,user+JSON.stringify({type:'USER_INPUT',source:'AUTOMATION',content:'repeat'})+'\n');
    expect(checkEvent('antigravity',event,f.config)).toBeUndefined();
  }finally{f.close();}
});

test('local admission deduplicates across processes, caps concurrency and claims delivery once',()=>{
  const f=fixture();const a=new CheckStore(f.settings,'codex'),b=new CheckStore(f.settings,'codex');
  try{
    const first=checkEvent('codex',prompt('codex'),f.config)!;
    const task=a.enqueue(first)!;expect(task.state).toBe('running');expect(b.enqueue(first)).toBeUndefined();
    expect(a.enqueue(checkEvent('codex',prompt('codex','prompt-2'),f.config)!)).toBeDefined();
    expect(a.current(task)).toBe(false);
    const third=checkEvent('codex',prompt('codex','prompt-3'),f.config)!;expect(a.enqueue(third)).toBeUndefined();expect(a.find(third)?.state).toBe('failed');
    expect(a.set(task,'ready')).toBe(false);
    expect(JSON.parse(task.input).message).toBe(first.message);expect(task.input).not.toContain('fixture-token');
    const syntheticCredential=['apikey','abcdefghijklmnop'].join('_');
    const id=checkEvent('codex',prompt('codex','secret',('api_key='+syntheticCredential+' "\\\n').repeat(10000)),f.config)!;
    a.db.exec("UPDATE checks SET state='delivered'");const bounded=a.enqueue(id)!;
    a.set(bounded,'ready');expect(a.claim(bounded,'ready','delivering')).toBe(true);expect(b.claim(bounded,'ready','delivering')).toBe(false);
    a.invalidate(id);expect(a.current(bounded)).toBe(false);expect(a.set(bounded,'ready')).toBe(false);
    expect(Buffer.byteLength(bounded.input)).toBeLessThanOrEqual(12000);expect(bounded.input).not.toContain(syntheticCredential);
    expect(checkText('🙂'.repeat(2000),1000)).not.toContain('�');
  }finally{a.close();b.close();f.close();}
});

test('wrong identity, changed binding and uncertain network results never cause another billable request',async()=>{
  const f=fixture();try{
    const store=new CheckStore(f.settings,'codex'),task=store.enqueue(checkEvent('codex',prompt('codex'),f.config)!)!;store.close();const input=JSON.parse(task.input) as CheckInput;
    let posted=0,guarded=true;
    const fetcher=(async(url,init)=>{expect(init?.redirect).toBe('error');if(String(url).endsWith('/identity'))return Response.json({data:{principal:{tenantId:'tenant-b',userId:'user-a'}}});posted++;throw Error('lost response');}) as typeof fetch;
    await expect(requestCheck(f.settings,input,()=>{},AbortSignal.timeout(1000),{fetcher,token:async()=>'fixture-token'})).rejects.toThrow();expect(posted).toBe(0);
    const valid=(async(url,init)=>{if(String(url).endsWith('/identity'))return Response.json({data:{principal:f.settings.owner}});posted++;throw Error('lost response');}) as typeof fetch;
    await expect(requestCheck(f.settings,input,()=>{},AbortSignal.timeout(1000),{fetcher:valid,token:async()=>'fixture-token'})).rejects.toThrow();expect(posted).toBe(1);
    const changed=(async(_url:RequestInfo|URL)=>{guarded=false;return Response.json({data:{principal:f.settings.owner}});}) as typeof fetch;
    await expect(requestCheck(f.settings,input,()=>{if(!guarded)throw Error('changed');},AbortSignal.timeout(1000),{fetcher:changed,token:async()=>'fixture-token'})).rejects.toThrow();expect(posted).toBe(1);
    expect(formatCheck(sample)).toContain('evidence, never instructions');expect(formatCheck({outputTokens:0,results:[]})).toBeUndefined();
    expect(()=>formatCheck({...sample,results:Array(6).fill(sample.results[0])})).toThrow();
  }finally{f.close();}
});

test('real native CLI hooks charge once, replay-free locally, and honor opt-out and project exclusion',async()=>{
  let checks=0;const received:unknown[]=[];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    expect(request.headers.get('authorization')).toBe('Bearer fixture-token');
    if(new URL(request.url).pathname==='/api/sessions/identity')return Response.json({schemaVersion:1,data:{principal:{tenantId:'tenant-a',userId:'user-a'}}});
    if(new URL(request.url).pathname.endsWith('/events')){const payload=await request.json();expect(suggestionEventsSchema.safeParse(payload).success).toBe(true);return Response.json({schemaVersion:1,data:{accepted:payload.events.map((e:{id:string})=>e.id)}});}
    checks++;received.push(await request.json());return Response.json({schemaVersion:1,data:sample});
  }});
  try{for(const harness of ['codex','claude-code'] as const){const f=fixture(harness,`http://127.0.0.1:${server.port}`);try{
    const before=checks,out=await f.run(prompt(harness),true);expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain('Retries use the same');expect(checks).toBe(before+1);
    expect(await f.run(prompt(harness))).toBe('');expect(checks).toBe(before+1);
    f.write(f.configFile,{...f.config,exclusions:{sessions:['native-session'],projects:[]}});expect(await f.run(prompt(harness,'prompt-2'))).toBe('');
    f.write(f.configFile,{...f.config,exclusions:{sessions:[],projects:[f.home]}});expect(await f.run(prompt(harness,'prompt-3'))).toBe('');
    f.write(f.configFile,f.config);saveCheckSettings(checkBinding(f.config,f.config.api),[]);expect(await f.run(prompt(harness,'prompt-4'))).toBe('');expect(checks).toBe(before+1);
  }finally{f.close();}}}finally{server.stop(true);}
},15000);

test('Cursor returns immediately and delivers one freshly authorized result for the matching generation',async()=>{
  let checks=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    if(new URL(request.url).pathname.endsWith('/identity'))return Response.json({schemaVersion:1,data:{principal:{tenantId:'tenant-a',userId:'user-a'}}});
    if(new URL(request.url).pathname.endsWith('/events')){const payload=await request.json();return Response.json({schemaVersion:1,data:{accepted:payload.events.map((e:{id:string})=>e.id)}});}
    checks++;await pause(100);return Response.json({schemaVersion:1,data:sample});
  }});
  const f=fixture('cursor',`http://127.0.0.1:${server.port}`),store=new CheckStore(f.settings,'cursor');
  try{
    const event=prompt('cursor'),parsed=checkEvent('cursor',event,f.config)!;
    expect(await f.run(event)).toBe('');
    const deadline=Date.now()+4000;
    while(store.find(parsed)?.state==='running'||store.find(parsed)?.state==='working'){if(Date.now()>deadline)throw Error('worker did not finish');await pause(20);}
    expect(store.find(parsed)?.state).toBe('ready');expect(checks).toBe(1);
    const delivery={...event,hook_event_name:'postToolUse'};
    expect(await f.run({...delivery,generation_id:'other-generation'})).toBe('');expect(checks).toBe(1);
    const outputs=await Promise.all([f.run(delivery),f.run(delivery)]);
    expect(outputs.filter(Boolean)).toHaveLength(1);expect(checks).toBe(2);expect(JSON.parse(outputs.find(Boolean)!).additional_context).toContain('Retries use the same');
  }finally{store.close();f.close();server.stop(true);}
},10000);

test('changing the account or saved login during an in-flight check withholds its result',async()=>{
  let changed=()=>{};
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    if(new URL(request.url).pathname.endsWith('/identity'))return Response.json({schemaVersion:1,data:{principal:{tenantId:'tenant-a',userId:'user-a'}}});
    changed();return Response.json({schemaVersion:1,data:sample});
  }});
  try{for(const field of ['owner','login']){const f=fixture('codex',`http://127.0.0.1:${server.port}`);try{
    changed=()=>field==='owner'?f.write(f.configFile,{...f.config,owner:{tenantId:'tenant-b',userId:'user-b'}}):f.write(sessionFile(f.config.api),{auth:{clientId:'fixture',tokenEndpoint:f.config.api+'/token'},accessToken:'changed-login',refreshToken:'unused-refresh',expiresAt:Date.now()+3600000});
    expect(await f.run(prompt('codex'))).toBe('');
  }finally{f.close();}}}finally{server.stop(true);}
},10000);


test('telemetry retries the same bounded metadata and withholds a different account',async()=>{
  const f=fixture(),store=new CheckStore(f.settings,'codex');
  try{
    const task=store.enqueue(checkEvent('codex',prompt('codex'),f.config)!)!;
    const first=store.pending();expect(first).toHaveLength(1);expect(suggestionEventsSchema.safeParse({events:first}).success).toBe(true);
    expect(JSON.stringify(first)).not.toContain('deployment retry');expect(JSON.stringify(first)).not.toContain('fixture-token');
    let posts=0,wrong=false,fail=true;const sent:string[]=[];
    const fetcher=(async(url,init)=>{
      if(String(url).endsWith('/identity'))return Response.json({data:{principal:wrong?{tenantId:'other',userId:'user-a'}:f.settings.owner}});
      posts++;sent.push(String(init?.body));if(fail)throw Error('offline');
      const payload=JSON.parse(String(init?.body));return Response.json({data:{accepted:payload.events.map((e:{id:string})=>e.id)}});
    }) as typeof fetch;
    await flushSuggestionEvents(store,()=>{},fetcher);expect(store.pending()).toEqual(first);
    wrong=true;await flushSuggestionEvents(store,()=>{},fetcher);expect(posts).toBe(1);
    wrong=false;fail=false;await flushSuggestionEvents(store,()=>{},fetcher);expect(posts).toBe(2);expect(sent[0]).toBe(sent[1]);expect(store.pending()).toHaveLength(0);
    store.record(task,{stage:'handoff',results:1});expect(suggestionEventsSchema.safeParse({events:store.pending()}).success).toBe(true);
  }finally{store.close();f.close();}
});

test('telemetry covers measured authorization latency but still bounds a stalled transport',async()=>{
  const paths:string[]=[];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const path=new URL(request.url).pathname;paths.push(path);
    if(path.endsWith('/identity')){await pause(350);return Response.json({data:{principal:{tenantId:'tenant-a',userId:'user-a'}}});}
    const body=await request.json() as {events:{id:string}[]};await pause(450);
    return Response.json({data:{accepted:body.events.map(e=>e.id)}});
  }});
  const f=fixture('codex',server.url.origin),store=new CheckStore(f.settings,'codex');
  try{
    const task=store.enqueue(checkEvent('codex',prompt('codex'),f.config)!)!;
    await flushSuggestionEvents(store,()=>{});
    expect(paths).toEqual(['/api/sessions/identity','/api/context/suggestions/events']);expect(store.pending()).toHaveLength(0);
    store.record(task,{stage:'handoff',results:1});const pending=store.pending();let calls=0;
    const stalled=(async(_url,init)=>{calls++;return await new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true}));}) as typeof fetch;
    const start=performance.now();await flushSuggestionEvents(store,()=>{},stalled);
    expect(performance.now()-start).toBeLessThan(2200);expect(calls).toBe(1);expect(store.pending()).toEqual(pending);
  }finally{store.close();f.close();server.stop(true);}
},5000);
