import type {createDevinConnections} from './devin-connections.mjs';
import {workloadConnectionHandler} from './workload-http.mjs';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Principal,DirectoryMembership} from './types.mjs';
import {errorInfo} from '../errors.mjs';

export const devinConnectionHandler = (connections: ReturnType<typeof createDevinConnections>) => workloadConnectionHandler(connections, 'Devin Cloud');

/** Human CLI approval. The runtime supplies freshly authenticated
 * scope and membership; the connection operation rechecks current admin access. */
export function devinApprovalHandler({connections,authenticate}:{
  connections:Pick<ReturnType<typeof createDevinConnections>,'issue'>;
  authenticate:(req:IncomingMessage)=>Promise<{principal:Principal;member:DirectoryMembership}>;
}) {
  return async(req:IncomingMessage,res:ServerResponse)=>{
    const json=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    const fail=(status:number)=>json(status,{schemaVersion:1,error:{code:status===401?'AUTH_REQUIRED':status===403?'WORKLOAD_APPROVAL_FORBIDDEN':status===400?'INVALID_REQUEST':'WORKLOAD_APPROVAL_UNAVAILABLE',message:status===403?'Only a current workspace admin can approve Devin Cloud.':status===401?'Sign in with the OpenCrawl CLI.':'Could not issue a Devin Cloud approval.'}});
    if(req.method!=='POST')return json(405,{schemaVersion:1,error:{code:'METHOD_NOT_ALLOWED'}});
    if('origin'in req.headers||(req.url??'').includes('?'))return fail(403);
    if(!/^Bearer \S+$/i.test(req.headers.authorization??''))return fail(401);
    try {
      const {principal,member}=await authenticate(req);
      const chunks:Buffer[]=[];let length=0;
      for await(const chunk of req){length+=chunk.length;if(length>4096)return fail(400);chunks.push(Buffer.from(chunk));}
      let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{return fail(400);}
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return fail(400);
      const approval=await connections.issue(principal,member);
      return json(200,{schemaVersion:1,data:{...approval,workspaceId:principal.tenantId}});
    }catch(error){const status=errorInfo(error).status;return fail(status&&[401,403].includes(status)?status:503);}
  };
}
