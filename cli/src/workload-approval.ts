import {closeSync,fstatSync,fsyncSync,lstatSync,openSync,unlinkSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {apiOrigin,CliError} from './oauth.ts';
import {accessToken} from './session.ts';
import {configuredProvider} from './workspace-identity.ts';

const usage='opencrawl workload approve --provider devin --api ORIGIN --code-file PATH [--json]';
const unavailable=()=>new CliError('WORKLOAD_APPROVAL_UNAVAILABLE','Could not issue a Devin Cloud approval. Check that the deployment supports workload approval, then retry.',2);
const invalid=()=>new CliError('WORKLOAD_PROTOCOL_ERROR','The approval response could not be verified. Request a new approval.',2);

async function approval(api:string,fetcher:typeof fetch){
  const signal=AbortSignal.timeout(30_000);
  // A human's saved CLI sign-in is the only authority for issuing this code.
  // Environment tokens never authorize it; provider mode is rejected before
  // reading any saved human identity.
  let token=await accessToken(api,undefined,fetcher,signal);
  for(let attempt=0;attempt<2;attempt++){
    let response:Response;
    try{response=await fetcher(api+'/api/cli/workloads/devin/approval',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}',redirect:'error',signal});}
    catch{throw unavailable();}
    if(response.status===401&&attempt===0){await response.body?.cancel();token=await accessToken(api,token,fetcher,signal);continue;}
    if(!response.ok){
      await response.body?.cancel();
      if(response.status===401)throw new CliError('AUTH_REQUIRED','Run opencrawl login, then request the approval again.',2);
      if(response.status===403)throw new CliError('WORKLOAD_APPROVAL_FORBIDDEN','Only a current workspace admin can approve Devin Cloud.',2);
      throw unavailable();
    }
    if(!response.body)throw invalid();
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0,value:unknown;
    try{
      for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>4096)throw invalid();chunks.push(part.value);}
      value=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    }catch{throw invalid();}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    if(!value||typeof value!=='object'||!('schemaVersion'in value)||value.schemaVersion!==1||!('data'in value))throw invalid();
    const data=value.data;
    if(!data||typeof data!=='object'||!('code'in data)||typeof data.code!=='string'||!/^[a-f0-9]{64}$/.test(data.code)||
      !('expiresAt'in data)||typeof data.expiresAt!=='string'||!(Date.parse(data.expiresAt)>Date.now())||
      !('workspaceId'in data)||typeof data.workspaceId!=='string'||!/^[A-Za-z0-9_.:-]{1,200}$/.test(data.workspaceId))throw invalid();
    return {code:data.code,expiresAt:data.expiresAt,workspaceId:data.workspaceId};
  }
  throw unavailable();
}

/** Reserve a new private file before issuing a capability. Never emit its
 * contents to logs, stdout, argv or environment variables. */
export async function approveWorkload(origin:string,file:string,fetcher=fetch){
  if(configuredProvider())throw new CliError('HUMAN_SIGN_IN_REQUIRED','Run workload approve on the admin machine with OPENCRAWL_AUTH unset. Use workload connect inside Devin Cloud.',64);
  const api=apiOrigin(origin),codeFile=resolve(file);
  let fd:number;
  try{fd=openSync(codeFile,'wx',0o600);}
  catch{throw new CliError('CODE_FILE_ERROR','Choose a new writable path for --code-file. Existing files are never replaced.',2);}
  const created=fstatSync(fd);let complete=false;
  const owned=()=>{try{const current=lstatSync(codeFile);return current.isFile()&&current.dev===created.dev&&current.ino===created.ino;}catch{return false;}};
  try{
    const issued=await approval(api,fetcher);
    if(!owned())throw new CliError('CODE_FILE_ERROR','The approval file changed. Choose a new path and retry.',2);
    try{writeFileSync(fd,issued.code+'\n');fsyncSync(fd);}
    catch{throw new CliError('CODE_FILE_ERROR','Could not save the approval. Choose a new writable path and retry.',2);}
    complete=true;
    return {api,provider:'devin' as const,workspaceId:issued.workspaceId,expiresAt:issued.expiresAt,codeFile};
  }finally{
    closeSync(fd);
    if(!complete&&owned())unlinkSync(codeFile);
  }
}

export async function workloadApprovalCommand(args:string[]){
  const json=args.includes('--json');
  try{
    const {positionals,values}=parseArgs({args,allowPositionals:true,options:{provider:{type:'string'},api:{type:'string'},'code-file':{type:'string'},json:{type:'boolean'},help:{type:'boolean',short:'h'}}});
    if(values.help){process.stdout.write(json?JSON.stringify({schemaVersion:1,data:{help:usage}})+'\n':usage+'\n');return 0;}
    if(positionals.length!==1||positionals[0]!=='approve'||values.provider!=='devin'||!values.api||!values['code-file']?.trim())throw new CliError('INVALID_USAGE','Use '+usage,64);
    const data=await approveWorkload(values.api,values['code-file']);
    process.stdout.write(json?JSON.stringify({schemaVersion:1,data})+'\n':`Devin Cloud approval saved to ${data.codeFile}; expires ${data.expiresAt}.\nSupply that file through a secure channel to workload connect --code-stdin in Devin Cloud, then delete the file. Keep its contents out of chats and repositories.\n`);
    return 0;
  }catch(error){
    const known=error instanceof CliError,code=known?error.code:'INVALID_USAGE',message=known?error.message:'Could not approve Devin Cloud. Use '+usage;
    if(json)process.stdout.write(JSON.stringify({schemaVersion:1,error:{code,message}})+'\n');else process.stderr.write(message+'\n');
    return known?error.exitCode:64;
  }
}
