import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {cursorEditorSessions,cursorStoreRecords,cursorStoreWorkspace} from '../src/capture/cursor-store.ts';

for(const editor of [false,true])test('committed Cursor '+(editor?'editor':'CLI')+' messages and tool records respect consent, retry and native identity',()=>{
  const root=mkdtempSync(join(tmpdir(),'cursor-store-')),session=randomUUID(),created=Date.now()-10_000;
  const workspace=join(root,'work'),bucket=createHash('md5').update(workspace).digest('hex');
  const path=editor?join(root,'state.vscdb'):join(root,'chats',bucket,session,'store.db');
  mkdirSync(dirname(path),{recursive:true});
  try{
    const db=new Database(path,{create:true});
    if(editor)db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY,value BLOB)');
    else{
      db.exec('CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)');
      writeFileSync(join(dirname(path),'meta.json'),JSON.stringify({cwd:workspace}));
      expect(cursorStoreWorkspace(root,session,path)).toBe(workspace);
    }
    const put=(key:string,value:Uint8Array|string)=>editor?
      db.query('INSERT OR REPLACE INTO cursorDiskKV VALUES(?,?)').run(key,value):
      db.query('INSERT OR REPLACE INTO blobs VALUES(?,?)').run(key,value);
    const blob=(bytes:Buffer)=>{const id=createHash('sha256').update(bytes).digest('hex');put(editor?'agentKv:blob:'+id:id,bytes);return id;};
    const message=(value:unknown)=>blob(Buffer.from(JSON.stringify(value)));
    const commit=(refs:string[])=>{
      const bytes=Buffer.concat(refs.map(ref=>Buffer.concat([Buffer.from([10,32]),Buffer.from(ref,'hex')])));
      if(editor)put('composerData:'+session,JSON.stringify({composerId:session,createdAt:created,conversationState:'~'+bytes.toString('base64')}));
      else db.query('INSERT OR REPLACE INTO meta VALUES(?,?)').run('0',Buffer.from(JSON.stringify({agentId:session,createdAt:created,latestRootBlobId:blob(bytes)})).toString('hex'));
    };
    const tool=(id:string,result:string)=>({role:'tool',content:[{type:'tool-result',toolCallId:id,toolName:'Read',result}]});
    const old=message(tool('old','before consent'));commit([old]);
    const since=created+1000;
    const first=cursorStoreRecords(root,session,path,since)!;expect(first.records).toEqual([]);
    message(tool('abandoned','uncommitted secret'));
    const refs=[old,message({role:'user',content:'model scaffold'}),
      message({role:'user',content:[{type:'text',text:'editor context'},{type:'text',text:'<timestamp>now</timestamp>\n<user_query>\nRead the file\n</user_query>'}]}),
      message({role:'assistant',content:[{type:'tool-call',toolCallId:'call',toolName:'Read',args:{path:'proof.txt'}}]}),
      message(tool('call','original tool bytes')),message({role:'assistant',content:[{type:'text',text:'visible answer'}]})];
    commit(refs);
    const second=cursorStoreRecords(root,session,path,since,first.cursor)!;
    expect(second.records.map(r=>r.kind)).toEqual(['message','tool_call','tool_result','message']);
    expect(second.records[2]!.data.output).toBe('original tool bytes');
    for(const hidden of ['before consent','uncommitted secret','model scaffold','editor context'])expect(JSON.stringify(second.records)).not.toContain(hidden);
    expect(cursorStoreRecords(root,session,path,since,second.cursor)).toBeNull();
    commit([...refs,'0'.repeat(64)]);
    expect(()=>cursorStoreRecords(root,session,path,since,second.cursor)).toThrow();
    db.close();
    if(editor){
      const index=new Database(join(root,'conversation-search.db'),{create:true});index.exec('CREATE TABLE conversations (id TEXT,updated_at INTEGER,is_archived INTEGER,source TEXT,scope TEXT)');
      const add=index.query('INSERT INTO conversations VALUES(?,?,?,?,?)');add.run(session,since+1,0,'local','');add.run(randomUUID(),since-4,0,'local','');add.run(randomUUID(),since+2,0,'cloud-cache','cloud');index.close();
      expect(cursorEditorSessions(root,since)).toEqual([{id:session,updated_at:since+1}]);
    }else{
      const link=join(root,'link');symlinkSync(dirname(path),link,'dir');
      expect(()=>cursorStoreRecords(root,session,join(link,'store.db'),since)).toThrow();
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
