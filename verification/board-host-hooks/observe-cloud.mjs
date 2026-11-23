// Diagnostic wrapper for the already loaded project command. Mirror its genuine
// stdin to the bound plugin. Persist only dispatch metadata and output keys.
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
const pointer=JSON.parse(fs.readFileSync(new URL('./fixture-pointer.json',import.meta.url)));
const raw=fs.readFileSync(0),event=JSON.parse(raw),kind=event.hook_event_name;
const action=kind==='beforeSubmitPrompt'||kind==='postToolUse'?'capture':kind==='stop'?'inbox':undefined;
if(!action){console.log('{}');process.exit(0);}
const result=spawnSync(pointer.node,[join(pointer.plugin,'bin/opencrawl-hook.mjs'),'--root',pointer.plugin,'--action',action],{input:raw,timeout:kind==='stop'?18000:8000,maxBuffer:16384});
let output;try{output=JSON.parse(result.stdout?.toString()||'{}');}catch{output={};}
fs.appendFileSync(join(dirname(pointer.plugin),'callbacks.jsonl'),JSON.stringify({event:kind,session:event.conversation_id,status:result.status,error:result.error?.code??null,stderr:result.stderr?.toString().slice(0,100),keys:Object.keys(output)})+'\n',{mode:0o600});
process.stdout.write(JSON.stringify(output)+'\n');
