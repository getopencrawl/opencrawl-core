import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {readNativeDatabase,regular} from './native-database.ts';
import {CliError} from '../oauth.ts';

const uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const digest=/^[a-f\d]{64}$/;
const invalid=()=>new CliError('CAPTURE_CURSOR_STORE_INVALID','Cursor supplied an unsupported or incomplete chat database; its checkpoint was retained.');
export function cursorStorePath(root:string,id:string,path:string){
  const parts=relative(resolve(root),resolve(path)).split(sep);
  return uuid.test(id)&&parts.length===4&&parts[0]==='chats'&&/^[a-f\d]{32}$/.test(parts[1]!)&&parts[2]===id&&parts[3]==='store.db';
}


export function cursorStoreWorkspace(root:string,id:string,path:string){
  if(!cursorStorePath(root,id,path))throw invalid();
  const file=join(dirname(path),'meta.json');
  if(regular(root,file).size>64*1024)throw invalid();
  const {cwd}=JSON.parse(readFileSync(file,'utf8'));
  if(typeof cwd!=='string'||!isAbsolute(cwd)||createHash('md5').update(cwd).digest('hex')!==basename(dirname(dirname(path))))throw invalid();
  return cwd;
}

// Cursor's committed conversation root stores its ordered model-message
// references in repeated protobuf field 1. Ignore all other fields and all
// unreachable blobs, including abandoned writes and model scaffolding.
function messageRefs(bytes:Uint8Array){
  const refs:string[]=[];let pos=0;
  function varint(){
    let n=0;
    for(let i=0;i<10&&pos<bytes.length;i++){
      const b=bytes[pos++]!;n+=(b&127)*2**(7*i);if(b<128)return n;
    }
    throw invalid();
  }
  while(pos<bytes.length){
    const tag=varint(),field=Math.floor(tag/8),wire=tag%8;
    if(!field||!Number.isSafeInteger(tag))throw invalid();
    if(wire===0)varint();
    else if(wire===1)pos+=8;
    else if(wire===5)pos+=4;
    else if(wire===2){
      const length=varint();
      if(!Number.isSafeInteger(length)||length>bytes.length-pos)throw invalid();
      if(field===1){
        if(length!==32)throw invalid();
        refs.push(Buffer.from(bytes.subarray(pos,pos+length)).toString('hex'));
      }
      pos+=length;
    }else throw invalid();
    if(pos>bytes.length)throw invalid();
  }
  return refs;
}

type SourceRecord = {kind:'tool_call'|'tool_result'|'message',nativeId:string,data:Record<string,unknown>};
export type StoreCursor = {head:string,seen:string[]};


export function defaultCursorEditorRoot(home:string,platform=process.platform){
  if(process.env.CURSOR_USER_DATA_DIR)return join(process.env.CURSOR_USER_DATA_DIR,'User','globalStorage');
  const parent=platform==='darwin'?join(home,'Library','Application Support'):
    platform==='win32'?(process.env.APPDATA??join(home,'AppData','Roaming')):(process.env.XDG_CONFIG_HOME??join(home,'.config'));
  return join(parent,'Cursor','User','globalStorage');
}

export function cursorEditorSessions(root:string,since:number){
  const path=join(root,'conversation-search.db');
  if(!lstatSync(path,{throwIfNoEntry:false}))return [];
  return readNativeDatabase(root,path,db=>{
    const query=db.query("SELECT id,updated_at FROM conversations WHERE source='local' AND scope='' AND is_archived=0 AND updated_at>=? ORDER BY updated_at,id");
    return Array.from(query.iterate(Math.floor(since)) as Iterable<{id:string,updated_at:number}>)
      .filter(row=>uuid.test(row.id)&&Number.isSafeInteger(row.updated_at));
  });
}

function recordsForMessage(msg:any,ref:string):SourceRecord[]{
  const records:SourceRecord[]=[];
  if(!Array.isArray(msg.content)||!['user','assistant','tool'].includes(msg.role))return records;
  // Model input may include editor state, system-generated prompts and
  // provider bookkeeping. Retain the visible user query and assistant text.
  const content=msg.content.filter((b:any)=>b?.type==='text'&&typeof b.text==='string'&&
    (msg.role==='assistant'||msg.role==='user'&&/^<timestamp>[^\n]*<\/timestamp>\n<user_query>\n[\s\S]*\n<\/user_query>$/.test(b.text)))
    .map((b:any)=>({type:'text',text:b.text}));
  if(content.length)records.push({kind:'message',nativeId:ref,data:{role:msg.role,content}});
  for(const block of msg.content){
    if(typeof block?.toolCallId!=='string'||!block.toolCallId||typeof block.toolName!=='string')continue;
    const info={name:block.toolName,call_id:block.toolCallId};
    if(msg.role==='assistant'&&block.type==='tool-call')records.push({kind:'tool_call',nativeId:block.toolCallId,data:{...info,type:'tool_use',input:block.args??block.input??null}});
    if(msg.role==='tool'&&block.type==='tool-result')records.push({kind:'tool_result',nativeId:block.toolCallId,data:{...info,type:'tool_result',output:block.result??block.output??null,...(block.isError||msg.providerOptions?.cursor?.highLevelToolCallResult?.isError?{is_error:true}:{})}});
  }
  return records;
}

export function cursorStoreRecords(root:string,id:string,path:string,since:number,previous?:StoreCursor){
  const editor=path===join(root,'state.vscdb');
  if(!uuid.test(id)||!editor&&!cursorStorePath(root,id,path))throw invalid();
  return readNativeDatabase(root,path,db=>{
    const sql=editor?'SELECT value AS data FROM cursorDiskKV WHERE key=? AND length(value)<=?':'SELECT data FROM blobs WHERE id=? AND length(data)<=?';
    const blob=db.query(sql);
    const get=(ref:string,limit=16*1024*1024)=>{
      const row=blob.get(editor?'agentKv:blob:'+ref:ref,limit) as {data:Uint8Array}|null;
      if(!row||createHash('sha256').update(row.data).digest('hex')!==ref)throw invalid();
      return row.data;
    };
    let head:string,createdAt:number,rootBytes:Uint8Array;
    if(editor){
      const row=db.query('SELECT value FROM cursorDiskKV WHERE key=? AND length(value)<=?').get('composerData:'+id,16*1024*1024) as {value:string}|null;
      if(!row)return null;
      const meta=JSON.parse(row.value);
      if(meta.composerId!==id||typeof meta.conversationState!=='string'||!meta.conversationState.startsWith('~'))throw invalid();
      rootBytes=Buffer.from(meta.conversationState.slice(1),'base64');
      head=createHash('sha256').update(rootBytes).digest('hex');createdAt=meta.createdAt;
    }else{
      const row=db.query("SELECT value FROM meta WHERE key='0' AND length(value)<=131072").get() as {value:string}|null;
      if(!row)throw invalid();
      const meta=JSON.parse(Buffer.from(row.value,'hex').toString('utf8'));
      head=meta.latestRootBlobId;createdAt=meta.createdAt;
      if(meta.agentId!==id||typeof head!=='string'||!digest.test(head))throw invalid();
      if(previous?.head===head)return null;
      rootBytes=get(head,8*1024*1024);
    }
    if(!Number.isSafeInteger(createdAt)||createdAt<=0)throw invalid();
    if(previous?.head===head)return null;
    const refs=messageRefs(rootBytes),seen=new Set(previous?.seen);
    const records:SourceRecord[]=[];
    const baseline=!previous&&createdAt<since;
    for(const ref of refs){
      if(seen.has(ref))continue;
      seen.add(ref);
      if(!baseline)records.push(...recordsForMessage(JSON.parse(Buffer.from(get(ref)).toString('utf8')),ref));
    }
    return {cursor:{head,seen:[...seen]},records,createdAt};
  });
}
