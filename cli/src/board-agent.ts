import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {boardRequest} from './board.ts';
import {CliError} from './oauth.ts';

type Values=Record<string,unknown>;
const number=(value:unknown)=>value===undefined?undefined:Number(value);
const list=(value:unknown)=>value===undefined?undefined:(Array.isArray(value)?value:[value]).flatMap(item=>String(item).split(',')).filter(Boolean);
const textFile=(file:unknown)=>readFileSync(file==='-'?0:String(file),'utf8');
const invalid=(message:string):never=>{throw new CliError('INVALID_USAGE',message,64);};
export const agentBoardCommands=new Set(['list','read','search','thread','post','reply','agents','channels','follow','unfollow','presence','sync']);

export function agentBoardInput(operation:string,values:Values,positionals:string[]){
  if(values.json&&values.jsonl)invalid('Use --json or --jsonl, not both.');
  const singleTarget=['thread','post','reply','follow','unfollow'].includes(operation);
  if(singleTarget&&positionals.length>1)invalid('Supply one target message ID.');
  if(['presence','sync','channels'].includes(operation)&&positionals.length)invalid('This command does not accept positional arguments.');
  if(singleTarget&&positionals.length&&values.thread!==undefined&&Number(positionals[0])!==Number(values.thread))invalid('Conflicting message targets.');
  const nativeSession=values.session??process.env.OPENCRAWL_SESSION_ID??process.env.CODEX_THREAD_ID;
  const identity={...nativeSession?{session:String(nativeSession)}:{},...values.agent?{agent:String(values.agent)}:{}};
  const base={...values.workspace?{workspace:String(values.workspace)}:{}};
  const pagination={limit:number(values.limit),select:list(values.select)};
  let input:Record<string,unknown>;
  if(operation==='list'||operation==='search')input={...base,...pagination,query:positionals.join(' '),channels:list(values.channel),from:list(values.from),order:values.order,
    after:number(values.after),before:number(values.before),thread:number(values.thread),rootsOnly:values['roots-only'],since:values.since,until:values.until,cursor:values.cursor,facets:list(values.facets)};
  else if(operation==='read'){
    const ids=[...positionals,...values.id?[String(values.id)]:[]].map(value=>Number(value.replace(/^message:/,'')));
    if(values.input===undefined&&(!ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<1)))invalid('Read requires one or more numeric message IDs.');
    input={...base,ids,select:pagination.select};
  }else if(operation==='thread')input={...base,...pagination,threadId:number(positionals[0]??values.thread),order:values.order,after:number(values.after),before:number(values.before),cursor:values.cursor};
  else if(operation==='post'||operation==='reply'){
    if(values.text!==undefined&&values['text-file']!==undefined)invalid('Use --text or --text-file, not both.');
    const text=values['text-file']!==undefined?textFile(values['text-file']):values.text;
    const channel=list(values.channel);if(channel&&channel.length!==1)invalid('Posting requires exactly one --channel.');
    if(operation==='reply'&&positionals.length!==1&&values.thread===undefined&&values.input===undefined)invalid('Reply requires a message ID.');
    if(values.input===undefined&&typeof text!=='string')invalid('Supply --text, --text-file PATH (or - for stdin), or --input JSON_FILE.');
    input={...base,...identity,posts:[{id:values.id??randomUUID(),channel:channel?.[0],text,replyTo:number(positionals[0]??values.thread),mentions:list(values.mention),follow:values['no-follow']?false:undefined}]};
  }else if(operation==='follow'||operation==='unfollow')input={...base,...identity,threadId:number(positionals[0]??values.thread),following:operation==='follow'};
  else if(operation==='sync')input={...base,...identity,...pagination,channels:list(values.channel),after:number(values.after)};
  else if(operation==='presence')input={...base,...identity,name:values.name,task:values.task,channels:list(values.channel),leave:values.leave};
  else if(operation==='agents')input={...base,query:positionals.join(' '),active:values.all?false:undefined,after:number(values.after),limit:number(values.limit)};
  else input={...base,after:number(values.after),limit:number(values.limit)};
  if(values.input!==undefined){
    if(values['text-file']!==undefined||values.text!==undefined)invalid('Use --input or message text, not both.');
    let parsed:unknown;try{parsed=JSON.parse(textFile(values.input));}catch{invalid('--input must contain valid JSON.');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))invalid('--input must be a JSON object.');
    input={...input,...parsed as Record<string,unknown>};
  }
  return Object.fromEntries(Object.entries(input).filter(([,value])=>value!==undefined));
}

export function renderBoard(data:Record<string,unknown>,values:Values,stdout:Pick<NodeJS.WriteStream,'write'>=process.stdout,stderr:Pick<NodeJS.WriteStream,'write'>=process.stderr){
  if(values.json&&values.jsonl)invalid('Use --json or --jsonl, not both.');
  if(values.json){stdout.write(JSON.stringify(data)+'\n');return;}
  if(data.warning)stderr.write(String(data.warning)+'\n');
  const rows=Array.isArray(data.messages)?data.messages:Array.isArray(data.agents)?data.agents:Array.isArray(data.channels)?data.channels:undefined;
  if(values.jsonl){
    for(const row of rows??[data])stdout.write(JSON.stringify(row)+'\n');
    if(data.next!==undefined&&data.next!==null)stderr.write(JSON.stringify({next:data.next})+'\n');
    return;
  }
  if(!rows){stdout.write(JSON.stringify(data)+'\n');return;}
  for(const row of rows){
    if(typeof row.text==='string')stdout.write(`#${row.id} ${row.from} [${row.channel}] ${row.time}${row.replyTo?` reply to #${row.replyTo}`:''}\n${row.text}\n\n`);
    else stdout.write(JSON.stringify(row)+'\n');
  }
  if(!rows.length)stdout.write('No results.\n');
  if(data.next!==undefined&&data.next!==null)stderr.write(`Next: ${data.next}\n`);
}
export async function agentBoardCommand(operation:string,api:string,values:Values,positionals:string[]){
  const input=agentBoardInput(operation,values,positionals);
  const remote=operation==='reply'?'post':operation==='unfollow'?'follow':operation;
  const data=await boardRequest(api,'v2/'+remote,input);
  renderBoard(data,values);
}
