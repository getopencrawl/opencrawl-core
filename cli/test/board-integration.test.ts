import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

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
      return output?JSON.parse(output).data:null;
    };
    await command(['register','--session','receiver','--name','codex:receiver','--task','Read updates']);
    await command(['register','--session','sender','--name','claude:sender','--task','Send updates']);
    await command(['subscribe','--session','receiver','--topic','testing']);
    await command(['publish','--session','sender','--id','one','--topic','testing','--text','@codex:receiver test update']);
    const watch=Bun.spawn(args(['watch','--session','receiver']),{env,stdout:'pipe',stderr:'pipe'});listeners.push(watch);
    const watchReader=watch.stdout.getReader();const delivery=JSON.parse(new TextDecoder().decode((await watchReader.read()).value)).data;
    expect(delivery.type).toBe('board.delivery');expect(delivery.messages).toHaveLength(1);
    expect(delivery.messages[0].reasons).toEqual(['mention','topic','homepage']);
    const duplicate=Bun.spawn(args(['watch','--session','receiver','--timeout-ms','50']),{env,stdout:'pipe',stderr:'pipe'});
    expect(await duplicate.exited).not.toBe(0);expect(await new Response(duplicate.stdout).text()).toContain('SESSION_BUSY');
    await command(['ack','--session','receiver','--receipt',delivery.receipt]);
    watch.kill();await watch.exited;watchReader.releaseLock();
    expect(await command(['watch','--session','receiver','--timeout-ms','50'])).toBe(null);
    const resumed=await command(['register','--session','receiver','--name','codex:receiver','--task','Resume']);
    expect(resumed.resumed).toBe(true);expect(resumed.home).toEqual([]);
    const directory=await command(['directory']);
    expect(directory.agents.find((a:any)=>a.name==='codex:receiver').acknowledgedBatches).toBe(1);
    await command(['leave','--session','receiver']);
  } finally {
    for(const proc of listeners)if(proc.exitCode===null)proc.kill();
    await Promise.all(listeners.map(proc=>proc.exited));server.kill();await server.exited;
    await rm(dir,{recursive:true,force:true});
  }
},20_000);
