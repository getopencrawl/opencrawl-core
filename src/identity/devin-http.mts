import type {IncomingMessage,ServerResponse} from 'node:http';
import {errorInfo} from '../errors.mjs';
import type {DirectoryMembership,Principal} from './types.mjs';
import type {createDevinConnections} from './devin-connections.mjs';
import {devinOrganization} from './devin-schema.mjs';
import {workloadConnectionHandler} from './workload-http.mjs';

type Connections = ReturnType<typeof createDevinConnections>;
type AuthenticateAdmin = (req:IncomingMessage)=>Promise<{principal:Principal;member:DirectoryMembership}>;

export const devinConnectionHandler = (connections:Connections)=>workloadConnectionHandler(connections,'Devin Cloud');

/** The CLI acts as a human administrator. Organization IDs in a disconnect
 * request identify a resource within the authenticated workspace. */
export function devinAdminHandler(connections:Connections,authenticate:AuthenticateAdmin,action:'approve'|'disconnect') {
  return async(req:IncomingMessage,res:ServerResponse)=>{
    function json(status:number,value:object){
      res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({schemaVersion:1,...value}));
    }
    function fail(status:number){
      const errors:Record<number,string>={400:'INVALID_REQUEST',401:'AUTH_REQUIRED',403:'WORKLOAD_APPROVAL_FORBIDDEN',404:'CONNECTION_NOT_FOUND',405:'METHOD_NOT_ALLOWED'};
      return json(status,{error:{code:errors[status]??'WORKLOAD_APPROVAL_UNAVAILABLE'}});
    }
    if(req.method!=='POST')return fail(405);
    if('origin' in req.headers||(req.url??'').includes('?'))return fail(403);
    if(!/^Bearer \S+$/i.test(req.headers.authorization??''))return fail(401);
    try{
      const {principal,member}=await authenticate(req);
      const chunks:Buffer[]=[];let bytes=0;
      for await(const chunk of req){
        bytes+=chunk.length;
        if(bytes>4096)return fail(400);
        chunks.push(Buffer.from(chunk));
      }
      let body:unknown;
      try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{return fail(400);}
      if(!body||typeof body!=='object'||Array.isArray(body))return fail(400);
      if(action==='disconnect'){
        if(Object.keys(body).length!==1||!('organizationId' in body))return fail(400);
        const org=devinOrganization.safeParse(body.organizationId);
        if(!org.success)return fail(400);
        await connections.revoke(principal,org.data);
        return json(200,{data:{organizationId:org.data,connected:false}});
      }
      if(Object.keys(body).length)return fail(400);
      const approval=await connections.issue(principal,member);
      return json(200,{data:{...approval,workspaceId:principal.tenantId}});
    }catch(error){
      const status=errorInfo(error).status;
      return fail(status&&[400,401,403,404].includes(status)?status:503);
    }
  };
}
