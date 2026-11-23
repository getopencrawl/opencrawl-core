// Hosted branch acceptance probe. Does not read account credentials or contact
// external services. Only native event shape and synthetic fixture state persist.
import fs from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const e=JSON.parse(fs.readFileSync(0,'utf8')),id=e.conversation_id??e.session_id;
const kind=e.hook_event_name;
if(typeof id!=='string'||id.length>200)process.exit(0);
const root=join(os.tmpdir(),'oc-host-hooks-'+createHash('sha256').update(process.cwd()).digest('hex').slice(0,20));
fs.mkdirSync(root,{recursive:true,mode:0o700});
const state=join(root,createHash('sha256').update(id).digest('hex')+'.state');
const stamp={time:Date.now(),event:kind,session:id,version:e.cursor_version,status:e.status,loop:e.loop_count,
  tool:e.tool_name,redacted:e.tool_output?.redacted===true,fields:Object.keys(e).sort()};
fs.appendFileSync(join(root,'events.jsonl'),JSON.stringify(stamp)+'\n',{mode:0o600});
if (kind==='beforeSubmitPrompt')console.log(JSON.stringify({continue:true}));
else if(kind==='stop' && e.status==='completed' && Number(e.loop_count??0)===0 && !fs.existsSync(state)){
  const word='COBALT-'+createHash('sha256').update(id).digest('hex').slice(0,8);
  try {fs.writeFileSync(state,'offered',{flag:'wx',mode:0o600});console.log(JSON.stringify({followup_message:'Native benchmark signal. Report '+word+' and finish.'}));}catch{console.log('{}');}
}else console.log('{}');
