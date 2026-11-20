import type {Readable} from 'node:stream';
import {parseArgs} from 'node:util';
import {apiOrigin} from './oauth.ts';
import {accessToken} from './session.ts';
import {workspaceIdentityEnabled} from './workspace-identity.ts';

const usage='opencrawl workload events --api ORIGIN --organization DEVIN_ORG (--key-stdin [--one-session] | --select-session DEVIN_SESSION | --off)';

export async function workloadEventCommand(args:string[],input:Readable) {
  try {
    const {values}=parseArgs({args,options:{api:{type:'string'},organization:{type:'string'},'key-stdin':{type:'boolean'},
      'one-session':{type:'boolean'},'select-session':{type:'string'},off:{type:'boolean'},json:{type:'boolean'},help:{type:'boolean',short:'h'}}});
    if(values.help){process.stdout.write(usage+'\n');return 0;}
    if(!values.api||!values.organization||!(/^(?:org-[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/).test(values.organization)||
       [values['key-stdin'],values['select-session'],values.off].filter(Boolean).length!==1||values['one-session']&&!values['key-stdin'])throw Error(usage);
    if(workspaceIdentityEnabled())throw Error('A signed-in human workspace administrator is required.');
    const api=apiOrigin(values.api),signal=AbortSignal.timeout(30000);
    let token=await accessToken(api,undefined,fetch,signal);
    let body;
    if(values['select-session']) {
      if(!/^devin-[a-zA-Z0-9_-]{1,194}$/.test(values['select-session']))throw Error(usage);
      body={organizationId:values.organization,selectSession:values['select-session']};
    } else {
      let serviceKey:string|null=null;
      if(values['key-stdin']) {
        if('isTTY' in input && input.isTTY)throw Error('Supply the service key from a private file or secret manager on stdin.');
        const chunks:Buffer[]=[];let bytes=0;
        for await(const part of input){bytes+=Buffer.byteLength(part);if(bytes>1200)throw Error('Invalid service key');chunks.push(Buffer.from(part));}
        serviceKey=Buffer.concat(chunks).toString().trim();
        if(!/^cog_[a-zA-Z0-9_-]{1,1024}$/.test(serviceKey))throw Error('Invalid service key');
      }
      body={organizationId:values.organization,serviceKey,...(values['one-session']&&{restrictToOneSession:true})};
    }
    const send=()=>fetch(api+'/api/cli/workloads/devin/event-grant',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify(body),signal,redirect:'error'});
    let response=await send();
    if(response.status===401){await response.body?.cancel();token=await accessToken(api,token,fetch,signal);response=await send();}
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
