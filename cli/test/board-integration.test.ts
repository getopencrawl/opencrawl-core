import {test,expect} from 'bun:test';
import {mkdtemp,readdir,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {skillFiles} from '../src/skills.ts';

test('real CLI processes register, deliver, acknowledge, exclude duplicate listeners and resume quietly',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'board-cli-'));
  const env={...process.env,OPENCRAWL_TOKEN:'disposable-board-test-token',OPENCRAWL_CONFIG_HOME:dir,OPENCRAWL_NO_UPDATE:'1'};
  const server=Bun.spawn(['node',resolve(import.meta.dir,'fixtures/board-server.mjs'),join(dir,'board.sqlite')],{env,stdout:'pipe',stderr:'pipe'});
  const listeners:ReturnType<typeof Bun.spawn>[]=[];
  try {
    const reader=server.stdout.getReader();const first=await reader.read();
    if(first.done)throw new Error(await new Response(server.stderr).text());
    const {api}=JSON.parse(new TextDecoder().decode(first.value));reader.releaseLock();
    const args=(items:string[])=>[process.execPath,resolve(import.meta.dir,'../src/cli.ts'),'board',...items,'--api',api,'--json'];
    const command=async(items:string[])=>{
      const proc=Bun.spawn(args(items),{env,stdout:'pipe',stderr:'pipe'});
      const [output,error,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
      if(code!==0)throw new Error(output||error);
      return output?(JSON.parse(output).data??JSON.parse(output)):null;
    };
    // Exercise the exact fallback agents receive, including multi-word task
    // quoting, through the real CLI and the server's required-field schema.
    const fallback=skillFiles()['SKILL.md'].match(/register once: (opencrawl board register .*? --json)\./)?.[1];
    expect(fallback).toBeDefined();
    const replacements:Record<string,string>={'<id>':'fallback','<harness>':'devin','<name>':'devin:fallback','"<task>"':'Read workspace updates'};
    const fallbackArgs=fallback!.match(/"[^"]*"|\S+/g)!.slice(2).map(value=>replacements[value]??value);
    const recovered=await command(fallbackArgs);
    expect(recovered).toMatchObject({session:'fallback',harness:'devin',name:'devin:fallback',task:'Read workspace updates',resumed:false});
    expect((await command(fallbackArgs)).resumed).toBe(true);
    await command(['leave','--session','fallback']);
    await command(['register','--session','receiver','--name','codex:receiver','--task','Read updates']);
    await command(['register','--session','sender','--name','claude:sender','--task','Send updates']);
    await command(['subscribe','--session','receiver','--topic','testing']);
    const publication=await command(['publish','--session','sender','--id','one','--topic','testing','--text','@codex:receiver test update']);
    const id=publication.accepted[0], target='message:'+id;
    const content = await command(['fetch', '--id', target]);
    expect(content.text).toBe('@codex:receiver test update');
    const multiple=await command(['fetch',target,target,'--concurrency','2']);
    expect(multiple.partial).toBe(false);expect(multiple.results).toHaveLength(2);
    expect(multiple.results[0].data.text).toBe(content.text);
    expect((await command(['fetch',target,'--workspace','fixture'])).text).toBe(content.text);
    for(const workspace of ['other-tenant','']){
      const denied=Bun.spawn(args(['fetch',target,'--workspace',workspace]),{env,stdout:'pipe',stderr:'pipe'});
      const output=await new Response(denied.stdout).text();
      expect(await denied.exited).not.toBe(0);expect(output).not.toContain(content.text);
    }
    const failed=Bun.spawn(args(['fetch',target,'message:999']),{env,stdout:'pipe',stderr:'pipe'});
    const partial=JSON.parse(await new Response(failed.stdout).text());
    expect(await failed.exited).toBe(1);expect(partial.data.partial).toBe(true);
    expect(partial.data.results[0].data.text).toBe(content.text);
    expect(partial.data.results[1].error.code).toBe('BOARD_NOT_FOUND');
    const watch=Bun.spawn(args(['watch','--session','receiver']),{env,stdout:'pipe',stderr:'pipe'});listeners.push(watch);
    const watchReader=watch.stdout.getReader();
    let output='';
    while(!output.includes('test update')) {
      const chunk=await watchReader.read();if(chunk.done)throw Error('Listener closed before the mention');
      output+=new TextDecoder().decode(chunk.value);
    }
    const delivery=output.trim().split('\n').map(line=>JSON.parse(line)).find(message=>message.id===id);
    expect(delivery).toMatchObject({id,from:'claude:sender',channel:'testing',text:'@codex:receiver test update',mentions:['codex:receiver']});
    const duplicate=Bun.spawn(args(['watch','--session','receiver','--timeout-ms','50']),{env,stdout:'pipe',stderr:'pipe'});
    expect(await duplicate.exited).not.toBe(0);expect(await new Response(duplicate.stdout).text()).toContain('SESSION_BUSY');
    // No model-managed ack: the running listener advances delivery by itself.
    for (let i=0;i<50;i++) {
      const state=await command(['directory']);
      if(state.agents.find((a:any)=>a.name==='codex:receiver').pending===null)break;
      await Bun.sleep(20);
    }
    watch.kill();await watch.exited;watchReader.releaseLock();
    expect(await command(['watch','--session','receiver','--timeout-ms','50'])).toBe(null);
    const resumed=await command(['register','--session','receiver','--name','codex:receiver','--task','Resume']);
    expect(resumed.resumed).toBe(true);expect(resumed.home).toEqual([]);
    const directory=await command(['directory']);
    expect(directory.agents.find((a:any)=>a.name==='codex:receiver').acknowledgedBatches).toBe(1);
    const channels=await command(['channels']);expect(channels.channels[0].channel).toBe('opencrawl');
    const reply=await command(['reply','--session','sender','--id','thread-reply','--channel','testing','--thread',String(id),'--text','Thread follow-up']);
    expect(reply.messages).toEqual([{id:reply.messages[0].id,thread:id}]);
    const thread=await command(['thread','--thread',String(id)]);expect(thread.messages.map((m:{id:number})=>m.id)).toEqual([id,reply.messages[0].id]);expect(thread.messages[1].text).toBe('Thread follow-up');
    // The model-facing inbox is independent of the stream's stdout receipt.
    // Exercise the installed listener command, restarting before handling its page.
    const nativeFlags = skillFiles()['SKILL.md'].match(/The command is opencrawl board watch --session <id> (.*?) --json/)![1].split(' ');
    const noticeArgs = ['wait', '--session', 'receiver', ...nativeFlags, '--timeout-ms', '1500'];
    // Registration through MCP need not have populated this CLI's capability cache.
    const boardDir = join(dir, 'opencrawl', 'board');
    const capability = (await readdir(boardDir)).find(name => name.endsWith('.capabilities.json'));
    await unlink(join(boardDir, capability!));
    const notice = await command(noticeArgs);
    expect(notice.type).toBe('board.notice');
    expect(notice.messages).toContainEqual(delivery);
    expect(notice.ids).toEqual(notice.messages.map((m: {id: number}) => m.id));
    expect(notice.cursor).toMatch(/^[0-9a-f]{64}$/);
    expect(await command(noticeArgs)).toEqual(notice);
    const refs = await command(['wait', '--session', 'receiver', '--ids-only', '--timeout-ms', '1500']);
    expect(refs).toEqual({type: 'board.notice', ids: notice.ids});
    const body = 'Review complete 🧪\n'.repeat(1100);
    const pending = await command(['publish','--session','sender','--channel','testing','--id','large','--text',body]);
    expect(await command(noticeArgs)).toMatchObject({ids: notice.ids, cursor: notice.cursor});
    const next = await command(['inbox','--session','receiver','--cursor',notice.cursor]);
    const full = await command(noticeArgs);
    expect(full.messages).toEqual(next.messages);
    expect(full.cursor).toBe(next.cursor);
    expect(full.messages).toContainEqual(expect.objectContaining({id: pending.accepted[0], text: body.trimEnd()}));
    expect(await command(['inbox','--session','receiver','--cursor',full.cursor])).toEqual({messages:[],cursor:null,more:false});
    expect(await command(['wait','--session','receiver',...nativeFlags,'--timeout-ms','100'])).toBe(null);
    await command(['leave','--session','receiver']);
  } finally {
    for(const proc of listeners)if(proc.exitCode===null)proc.kill();
    await Promise.all(listeners.map(proc=>proc.exited));server.kill();await server.exited;
    await rm(dir,{recursive:true,force:true});
  }
},20_000);
