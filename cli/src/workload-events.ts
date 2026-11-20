import type {Readable} from 'node:stream';
import {parseArgs} from 'node:util';
import {apiOrigin,CliError} from './oauth.ts';
import {accessToken} from './session.ts';
import {workspaceIdentityEnabled} from './workspace-identity.ts';

const usage='opencrawl workload events --api ORIGIN --organization DEVIN_ORG (--key-stdin [--one-session] | --select-session DEVIN_SESSION | --off)';

export const organizationPattern = /^(?:org-[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;

async function readServiceKey(input:Readable) {
  if ('isTTY' in input && input.isTTY) throw new CliError('INVALID_USAGE','Pipe the Devin service key from a private file or secret manager.');
  const chunks:Buffer[]=[];
  let bytes=0;
  for await (const part of input) {
    bytes+=Buffer.byteLength(part);
    if (bytes>1200) throw new CliError('INVALID_DEVIN_KEY','Invalid Devin service key.');
    chunks.push(Buffer.from(part));
  }
  const key=Buffer.concat(chunks).toString().trim();
  if (!/^cog_[a-zA-Z0-9_-]{1,1024}$/.test(key)) throw new CliError('INVALID_DEVIN_KEY','Invalid Devin service key.');
  return key;
}

async function grantRequest(api:string,body:object) {
  if (workspaceIdentityEnabled()) throw new CliError('AUTH_REQUIRED','Sign in as a human workspace administrator.');
  const signal=AbortSignal.timeout(30000);
  let token=await accessToken(api,undefined,fetch,signal);
  const send=()=>fetch(api+'/api/cli/workloads/devin/event-grant',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    body:JSON.stringify(body),signal,redirect:'error'});
  let response=await send();
  if(response.status===401){await response.body?.cancel();token=await accessToken(api,token,fetch,signal);response=await send();}
  return response;
}

const recordingErrors:Record<string,string>={
  DEVIN_CONNECTION_REQUIRED:'Connect the Devin organization to this workspace before exporting a recording plugin.',
  DEVIN_ORGANIZATION_REQUIRED:'This workspace has several Devin connections. Select one with --organization DEVIN_ORG.',
  DEVIN_RECORDING_CREDENTIAL_REQUIRED:'Recording includes the first turn. Supply the Devin organization service key to this bundle command using --key-stdin and a private file or secret manager.',
  DEVIN_RECORDING_EVENTS_UNAVAILABLE:'The Devin service account cannot access the session events tool. Check its permissions in Devin.',
  DEVIN_RECORDING_CREDENTIAL_INVALID:'Devin rejected the recording credential for this organization. Check the service user and replace its key with workload events --key-stdin.',
  DEVIN_RECORDING_SCOPE_MISMATCH:'The existing credential has a different scope. Use --one-session only for a single-session pilot, or change its scope explicitly with workload events.',
  DEVIN_RECORDING_KEY_CHANGED:'A different recording credential is already configured. Reuse it by omitting --key-stdin, or rotate it explicitly with workload events.'
};

export async function prepareDevinRecording(api:string,organizationId:string|undefined,oneSession:boolean,input?:Readable) {
  if (organizationId!==undefined && !organizationPattern.test(organizationId)) throw new CliError('INVALID_USAGE','Supply a valid Devin organization ID.');
  const response=await grantRequest(api,{action:'prepareRecording',organizationId,serviceKey:input?await readServiceKey(input):undefined,
    restrictToOneSession:oneSession||undefined});
  const receipt=await response.json().catch(()=>null);
  if (!response.ok) {
    const code=receipt?.error?.code;
    if (typeof code==='string' && Object.hasOwn(recordingErrors,code)) throw new CliError(code,recordingErrors[code]!);
    if (response.status===403) throw new CliError('AUTH_FORBIDDEN','A workspace administrator must prepare Devin recording.');
    throw new CliError('DEVIN_RECORDING_UNAVAILABLE','Could not verify Devin recording (HTTP '+response.status+'). Check the receiver version and retry.');
  }
  const data=receipt?.data;
  if (data?.recording!==true || typeof data.organizationId!=='string' || !organizationPattern.test(data.organizationId) ||
      (organizationId && data.organizationId!==organizationId) || data.scope!==(oneSession?'one-session':'organization')) {
    throw new CliError('INVALID_DEVIN_RECEIPT','The receiver did not confirm recording setup for this Devin organization.');
  }
}

export async function workloadEventCommand(args:string[],input:Readable) {
  try {
    const {values}=parseArgs({args,options:{api:{type:'string'},organization:{type:'string'},'key-stdin':{type:'boolean'},
      'one-session':{type:'boolean'},'select-session':{type:'string'},off:{type:'boolean'},json:{type:'boolean'},help:{type:'boolean',short:'h'}}});
    if(values.help){process.stdout.write(usage+'\n');return 0;}
    if(!values.api||!values.organization||!organizationPattern.test(values.organization)||
       [values['key-stdin'],values['select-session'],values.off].filter(Boolean).length!==1||values['one-session']&&!values['key-stdin'])throw Error(usage);
    const api=apiOrigin(values.api);
    let body;
    if(values['select-session']) {
      if(!/^devin-[a-zA-Z0-9_-]{1,194}$/.test(values['select-session']))throw Error(usage);
      body={organizationId:values.organization,selectSession:values['select-session']};
    } else {
      const serviceKey=values['key-stdin']?await readServiceKey(input):null;
      body={organizationId:values.organization,serviceKey,...(values['one-session']&&{restrictToOneSession:true})};
    }
    const response=await grantRequest(api,body);
    if(!response.ok){await response.body?.cancel();process.stderr.write('Devin event grant request failed (HTTP '+response.status+').\n');return 2;}
    const data=(await response.json()).data;
    if(data?.organizationId!==values.organization || (values['select-session'] ? data.sessionId!==values['select-session'] : data.enabled!==!values.off))throw Error('Invalid grant receipt');
    const receipt=values['select-session']?{organizationId:values.organization,sessionId:values['select-session']}:{organizationId:values.organization,enabled:!values.off};
    process.stdout.write(JSON.stringify({schemaVersion:1,data:receipt})+'\n');
    return 0;
  } catch {
    process.stderr.write('Could not configure the Devin event grant. Use a saved workspace admin login.\n'+usage+'\n');
    return 2;
  }
}
