import {test,expect} from 'bun:test';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const mcpSignIn='disposable-mcp-sign-in-token-0000';
test('cloud listener: MCP ticket replaces CLI sign-in, is single use, session bound and revoked on leave',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'board-listener-cli-'));
  // No OPENCRAWL_TOKEN and no saved login: the ticket is the only CLI credential.
  const {OPENCRAWL_TOKEN:_,...base}=process.env;
  const env={...base,OPENCRAWL_CONFIG_HOME:dir,OPENCRAWL_NO_UPDATE:'1'};
  const port=20000+Math.floor(Math.random()*20000);
  const server=Bun.spawn(['node',resolve(import.meta.dir,'fixtures/listener-server.mjs'),dir,String(port)],{env,stdout:'pipe',stderr:'pipe'});
  let watch:ReturnType<typeof Bun.spawn>|undefined;
  try {
    const reader=server.stdout.getReader();const first=await reader.read();
    if(first.done)throw new Error(await new Response(server.stderr).text());
    const {api}=JSON.parse(new TextDecoder().decode(first.value));reader.releaseLock();
    const ticket=async(session:string)=>{
      const response=await fetch(api+'/mcp',{method:'POST',headers:{authorization:'Bearer '+mcpSignIn,'content-type':'application/json',accept:'application/json, text/event-stream'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'board_listener_ticket',arguments:{session}}})});
      const text=await response.text();const body=JSON.parse(text.startsWith('{')?text:text.split('\n').find(l=>l.startsWith('data:'))!.slice(5));
      return JSON.parse(body.result.content[0].text).ticket as string;
    };
    const args=(items:string[])=>[process.execPath,resolve(import.meta.dir,'../src/cli.ts'),'board',...items,'--api',api,'--json'];
    const run=async(items:string[])=>{
      const proc=Bun.spawn(args(items),{env,stdout:'pipe',stderr:'pipe'});
      const [output,error,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
      return {code,output:output?JSON.parse(output):null,error};
    };
    const mcpBoard=async(operation:string,body:Record<string,unknown>)=>(await fetch(`${api}/api/board/${operation}`,{method:'POST',headers:{authorization:'Bearer '+mcpSignIn,'content-type':'application/json'},body:JSON.stringify(body)})).json();

    // Without a credential the CLI cannot register.
    expect((await run(['register','--session','cloud','--name','claude:cloud','--task','x'])).code).not.toBe(0);
    const t1=await ticket('cloud');
    expect((await run(['register','--session','other','--ticket',t1,'--name','claude:other','--task','x'])).output.error.code).toBe('INVALID_USAGE');
    // A mismatched session does not consume the ticket; it then redeems once for its own session.
    const registered=await run(['register','--session','cloud','--ticket',t1,'--name','claude:cloud','--task','Cloud E2E','--harness','claude-code']);
    expect(registered.code).toBe(0);expect(registered.output.data.name).toBe('claude:cloud');
    expect((await run(['register','--session','cloud','--ticket',t1,'--name','claude:cloud','--task','x'])).output.error.code).toBe('AUTH_REQUIRED');
    const files=await readdir(join(dir,'opencrawl','board'));expect(files).toHaveLength(1);
    const state=JSON.parse(await readFile(join(dir,'opencrawl','board',files[0]),'utf8'));
    expect(state.listener.token).toMatch(/^ocl1_/);expect(state.workspace).toBe('fixture');
    expect((await run(['subscribe','--session','cloud','--topic','build'])).code).toBe(0);
    // Another session cannot borrow this session's token.
    expect((await run(['inbox','--session','elsewhere'])).code).not.toBe(0);

    watch=Bun.spawn(args(['watch','--session','cloud','--compact']),{env,stdout:'pipe',stderr:'pipe'});
    await mcpBoard('register',{session:'local',name:'codex:local',task:'Send'});
    await mcpBoard('publish',{session:'local',id:'1',topic:'build',text:'@claude:cloud marker-7f3a delivered'});
    const line=JSON.parse(new TextDecoder().decode((await (watch.stdout as ReadableStream<Uint8Array>).getReader().read()).value).split('\n')[0]).data;
    expect(line).toMatchObject({type:'board.message',text:'@codex:local [build] @claude:cloud marker-7f3a delivered',end:true});
    watch.kill();await watch.exited;

    expect((await run(['leave','--session','cloud'])).code).toBe(0);
    expect(JSON.parse(await readFile(join(dir,'opencrawl','board',files[0]),'utf8')).listener).toBeUndefined();
    const reused=await fetch(`${api}/api/board/inbox`,{method:'POST',headers:{authorization:'Bearer '+state.listener.token,'content-type':'application/json'},body:JSON.stringify({session:'cloud'})});
    expect(reused.status).toBe(401);
  } finally {
    if(watch&&watch.exitCode===null)watch.kill();
    server.kill();await server.exited;await rm(dir,{recursive:true,force:true});
  }
},30_000);
