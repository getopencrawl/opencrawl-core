import type {Readable} from 'node:stream';
import {parseArgs} from 'node:util';
import {apiOrigin,CliError,DEFAULT_API_ORIGIN} from './oauth.ts';
import {withEnvironmentTokenOrigin} from './environment-token.ts';
import {configuredProvider,createWorkspaceTokenProvider,workspaceIdentityEnabled} from './workspace-identity.ts';

export type EnrollmentFetch=(url:string,init:RequestInit)=>Promise<Response>;

const help=`Usage: opencrawl workload connect --code-stdin --api https://host [--json]
       opencrawl workload bundle --api ORIGIN --directory PATH --command LINUX_EXECUTABLE --config-home CLOUD_PROFILE --recording on|off [--json]

Connect a cloud organization using its administrator's one-time setup code.
Select OPENCRAWL_AUTH=devin-cloud or replicas-workspace in that cloud session.
Supply only the setup code on stdin; never paste an identity token or a human
credential. The provider's official helper obtains renewable identity locally.
The code and token are not saved. Repeating the same code from the same cloud
session safely retries interrupted enrollment until the approval expires.
This connects the organization; capture, plugin installation and verification
remain separate setup steps.

Bundle exports a public Devin Cloud plugin for review and native installation.
Its SessionStart hook invokes workload start --api ORIGIN with native hook input;
do not invoke startup manually or manufacture session events.
`;

/** Read one bounded capability, not an argv or environment credential. */
export function readEnrollmentCode(input:Readable,timeoutMs=5000):Promise<string>{
  return new Promise((resolve,reject)=>{
    let body=Buffer.alloc(0),done=false;
    const finish=(error?:Error,code?:string)=>{
      if(done)return;done=true;clearTimeout(timer);input.off('data',data);input.off('end',end);input.off('error',failed);input.pause();
      if(error)reject(error);else resolve(code!);
    };
    const failed=()=>finish(new CliError('INVALID_SETUP_CODE','Supply one current setup code on stdin.',64));
    const parse=()=>{
      const value=body.toString('utf8').trim();
      if(!/^[a-f0-9]{64}$/.test(value))failed();else finish(undefined,value);
    };
    const data=(chunk:Buffer|string)=>{body=Buffer.concat([body,Buffer.from(chunk)]);if(body.length>128){failed();return;}if(body.includes(10))parse();};
    const end=()=>parse(),timer=setTimeout(failed,timeoutMs);
    input.on('data',data);input.once('end',end);input.once('error',failed);
  });
}

async function responseJson(response:Response){
  if(!response.body)throw new CliError('WORKLOAD_PROTOCOL_ERROR','The connection response could not be verified. Retry the same setup code.',2);
  const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4096)throw Error();chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}
  catch{throw new CliError('WORKLOAD_PROTOCOL_ERROR','The connection response could not be verified. Retry the same setup code.',2);}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

/** The existing server atomically binds the admin capability to verified
 * provider claims. This client never submits a tenant, requester or owner. */
export async function connectWorkload(api:string,code:string,{fetcher=fetch,mint,signal}:{fetcher?:EnrollmentFetch;mint?:ReturnType<typeof createWorkspaceTokenProvider>;signal?:AbortSignal}={}){
  if(!/^[a-f0-9]{64}$/.test(code))throw new CliError('INVALID_SETUP_CODE','Supply one current setup code on stdin.',64);
  if(!workspaceIdentityEnabled())throw new CliError('WORKLOAD_IDENTITY_REQUIRED','Run this command in the cloud session with OPENCRAWL_AUTH=devin-cloud or replicas-workspace.',64);
  const provider=configuredProvider()!,origin=apiOrigin(api),tokenFor=mint??createWorkspaceTokenProvider({provider});
  const deadline=signal?AbortSignal.any([signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000);
  let token=await tokenFor(origin,undefined,deadline);
  for(let attempt=0;attempt<2;attempt++){
    let response:Response;
    try{response=await fetcher(origin+'/api/'+provider+'/connect',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({code}),redirect:'error',signal:deadline});}
    catch{throw new CliError('WORKLOAD_CONNECT_UNAVAILABLE','The cloud connection could not be confirmed. Retry the same setup code from this session.',2);}
    if(response.status===401&&attempt===0){await response.body?.cancel();token=await tokenFor(origin,token,deadline);continue;}
    if(!response.ok){
      await response.body?.cancel();
      const messages:Record<number,[string,string]>={
        400:['INVALID_SETUP_CODE','The setup code was rejected. Copy the current code from OpenCrawl.'],
        401:['WORKSPACE_IDENTITY_INVALID','The server could not verify this cloud identity. Keep the code and repair provider identity before retrying.'],
        403:['WORKLOAD_APPROVAL_REQUIRED','The approval is invalid, expired, or its administrator no longer has access. Ask the workspace admin for a fresh setup code.'],
        409:['WORKLOAD_APPROVAL_CONFLICT','The approval was used by another cloud session or organization. Ask the workspace admin for a fresh setup code.'],
      };
      const failure=messages[response.status]??['WORKLOAD_CONNECT_UNAVAILABLE','The cloud connection could not be confirmed. Retry the same setup code from this session.'];
      throw new CliError(failure[0]!,failure[1]!,2);
    }
    const result=await responseJson(response);
    if(!result||typeof result!=='object'||Array.isArray(result)||!('connected'in result)||result.connected!==true||!('organizationId'in result)||typeof result.organizationId!=='string'||!('tenantId'in result)||typeof result.tenantId!=='string'||
      !/^[A-Za-z0-9_.:-]{1,200}$/.test(result.organizationId)||!/^[A-Za-z0-9_.:-]{1,200}$/.test(result.tenantId))
      throw new CliError('WORKLOAD_PROTOCOL_ERROR','The connection response could not be verified. Retry the same setup code.',2);
    return {provider,organizationId:result.organizationId,tenantId:result.tenantId,connected:true};
  }
  throw new CliError('WORKLOAD_CONNECT_UNAVAILABLE','The cloud connection could not be confirmed. Retry the same setup code from this session.',2);
}

/** No updater, skill refresh, interactive login or capture migration occurs. */
export async function workloadCommand(args:string[],input:Readable=process.stdin){
  if(args[0]==='bundle'||args[0]==='start')return (await import('./workload-plugin-command.ts')).workloadPluginCommand(args,input);
  const json=args.includes('--json');
  try{
    const {positionals,values}=parseArgs({args,allowPositionals:true,options:{'code-stdin':{type:'boolean'},api:{type:'string'},json:{type:'boolean'},help:{type:'boolean',short:'h'}}});
    if(values.help){process.stdout.write(json?JSON.stringify({schemaVersion:1,data:{help}})+'\n':help);return 0;}
    if(positionals.length!==1||positionals[0]!=='connect'||!values['code-stdin'])throw new CliError('INVALID_USAGE','Use opencrawl workload connect --code-stdin --api https://host.',64);
    // Never let saved capture configuration redirect a newly provided capability.
    const origin=values.api??process.env.OPENCRAWL_API_URL??DEFAULT_API_ORIGIN,api=apiOrigin(origin);
    if(!workspaceIdentityEnabled())throw new CliError('WORKLOAD_IDENTITY_REQUIRED','Run this command in the cloud session with OPENCRAWL_AUTH=devin-cloud or replicas-workspace.',64);
    const code=await readEnrollmentCode(input),result=await withEnvironmentTokenOrigin(origin,()=>connectWorkload(api,code));
    process.stdout.write(json?JSON.stringify({schemaVersion:1,data:result})+'\n':`Connected ${result.provider} organization ${result.organizationId} to workspace ${result.tenantId}.\n`);return 0;
  }catch(error){
    const known=error instanceof CliError,code=known?error.code:'INVALID_USAGE',message=known?error.message:'Could not read workload enrollment arguments. Run opencrawl workload --help.';
    if(json)process.stdout.write(JSON.stringify({schemaVersion:1,error:{code,message}})+'\n');else process.stderr.write(message+'\n');
    return known?error.exitCode:64;
  }
}
