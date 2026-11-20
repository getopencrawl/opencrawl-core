import {admitActivity} from '../application/agent-activity.mjs';
import type {Authenticate,HttpHandler} from '../sessions/types.mjs';
import {setupInvitation,type SetupInvitations} from './invitations.mjs';
import {serviceError} from '../sessions/types.mjs';
import type {createSetupStatus} from './status.mjs';

/** Portable CLI protocol. Browser reads use their runtime's authenticated principal. */
export function createSetupHandler({setup,authenticate,invitations}:{setup:ReturnType<typeof createSetupStatus>;authenticate:Authenticate;invitations?:SetupInvitations}):HttpHandler {
  return async(req,res)=>{
    const send=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({schemaVersion:1,...value as object}));};
    try {
      if(req.headers.origin)return send(403,{error:{code:'BROWSER_REQUEST_DENIED'}});
      const url=new URL(req.url||'/', 'http://setup.invalid');
      if(url.search)return send(400,{error:{code:'INVALID_SETUP_REQUEST'}});
      if(url.pathname==='/api/setup/invitations'){
        if(!invitations)return send(404,{error:{code:'SETUP_NOT_FOUND'}});
        if(req.method!=='GET'&&req.method!=='POST')return send(405,{error:{code:'METHOD_NOT_ALLOWED'}});
        return send(200,{data:await setupInvitation(req,invitations)});
      }
      const operation=url.pathname==='/api/setup'&&req.method==='GET'?'read':url.pathname==='/api/setup/installation'&&req.method==='POST'?'installation':url.pathname==='/api/setup/verify'&&req.method==='POST'?'verify':null;
      if(!operation)return send(405,{error:{code:'METHOD_NOT_ALLOWED'}});
      const principal=await authenticate(req);
      if(!principal)return send(401,{error:{code:'AUTH_REQUIRED'}});
      admitActivity(principal);
      const revalidate=async()=>{
        const current=await authenticate(req);
        if(!current||current.tenantId!==principal.tenantId||current.userId!==principal.userId||current.captureAccess!==principal.captureAccess)throw Object.assign(new Error('Setup access changed'),{status:403});
      };
      if(operation==='read'){const data=await setup.read(principal);await revalidate();return send(200,{data});}
      let size=0;const chunks:Buffer[]=[];
      for await(const chunk of req){size+=chunk.length;if(size>16384)return send(413,{error:{code:'REQUEST_TOO_LARGE'}});chunks.push(Buffer.from(chunk));}
      let input:unknown;try{input=JSON.parse(Buffer.concat(chunks).toString());}catch{return send(400,{error:{code:'INVALID_JSON'}});}
      // A slow request body must not extend revoked membership or switch scope.
      await revalidate();const data=await setup[operation](principal,input);await revalidate();
      return send(200,{data});
    } catch(caught) {
      const error=serviceError(caught),status=[400,401,403,404,409].includes(error.status??0)?error.status!:503;
      return send(status,{error:{code:status===401?'AUTH_REQUIRED':status===403?'SETUP_FORBIDDEN':status===409?'SETUP_CHANGED':status===404?'SETUP_NOT_FOUND':status===400?'INVALID_SETUP_REQUEST':'SETUP_UNAVAILABLE',message:status===400||status===409?error.message:'Setup information is unavailable.'}});
    }
  };
}
