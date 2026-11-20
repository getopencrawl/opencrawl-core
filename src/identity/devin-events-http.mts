import type {IncomingMessage,ServerResponse} from 'node:http';
import {z} from 'zod';
import {errorInfo,fail} from '../errors.mjs';
import {readDevinStartupEvents} from '../integrations/devin-first-turn.mjs';
import {verifyDevinEventCredential} from '../integrations/devin-events-client.mjs';
import {createControls} from '../sessions/controls.mjs';
import type {RecordingPolicy} from '../sessions/recording.mjs';
import type {ObjectStore,Principal} from '../sessions/types.mjs';
import type {SetupState} from '../state/setup.mjs';
import type {DevinState} from '../state/devin.mjs';
import type {DirectoryMembership} from './types.mjs';
import type {createDevinWorkloads} from './devin.mjs';
import {devinOrganization,scope} from './devin-schema.mjs';
import {isAdmin as adminMembership} from './team.mjs';

export interface DevinStartupServices {setup:SetupState;recording:RecordingPolicy;store:ObjectStore;prefix:string}
type Options={repository:DevinState;workloads:ReturnType<typeof createDevinWorkloads>;audience:string;tenantId?:string;
  isAdmin:(principal:Principal)=>Promise<boolean>;
  authenticateAdmin:(req:IncomingMessage)=>Promise<{principal:Principal;member:DirectoryMembership}>;
  startup?:DevinStartupServices;};
const grantInput=z.union([z.strictObject({organizationId:devinOrganization,serviceKey:z.string().regex(/^cog_[a-zA-Z0-9_-]{1,1024}$/).nullable(),restrictToOneSession:z.boolean().optional()}),
  z.strictObject({organizationId:devinOrganization,selectSession:z.string().regex(/^devin-[a-zA-Z0-9_-]{1,194}$/)})]);
const startupInput=z.strictObject({installationId:scope,through:z.iso.datetime({offset:true})});

export function devinEventsHandler(options:Options,operation:'grant'|'startup') {
  const controls=options.startup && createControls({store:options.startup.store,prefix:options.startup.prefix});
  return async (req:IncomingMessage,res:ServerResponse)=>{
    const send=(status:number,value:object)=>{
      res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({schemaVersion:1,...value}));
    };
    try {
      if(req.method!=='POST')fail(405,'POST required');
      if('origin' in req.headers||(req.url??'').includes('?'))fail(403,'CLI request required');
      const token=/^Bearer (\S+)$/i.exec(req.headers.authorization??'')?.[1];
      if(!token)fail(401,'Sign-in required');
      const grants=options.repository.eventGrants;
      if(!grants||!options.startup||!controls)fail(404,'Devin event recording is unavailable');
      const body=async()=>{
        let bytes=0;const pieces:Buffer[]=[];
        for await(const piece of req){bytes+=Buffer.byteLength(piece);if(bytes>4096)fail(400,'Request exceeds limit');pieces.push(Buffer.from(piece));}
        try{return JSON.parse(Buffer.concat(pieces).toString());}catch{return fail(400,'Invalid request');}
      };
      if(operation==='grant') {
        const {principal,member}=await options.authenticateAdmin(req);
        const canManage=()=>options.isAdmin(principal);
        if(principal.owner||principal.captureAccess!==undefined||options.tenantId&&principal.tenantId!==options.tenantId||
           member.status!=='active'||member.organizationId!==principal.tenantId||member.userId!==principal.userId||!adminMembership(member)||!await canManage())fail(403,'Workspace admin required');
        const input=grantInput.safeParse(await body());
        if(!input.success)fail(400,'Invalid event grant');
        const {organizationId}=input.data;
        const {record,version}=await options.repository.readConnection(organizationId);
        if(!record||!version||record.tenantId!==principal.tenantId||record.revokedAt)fail(404,'Active connection required');
        if('selectSession' in input.data) {
          if(!await canManage())fail(403,'Workspace admin required');
          await grants.select(principal.tenantId,organizationId,version,input.data.selectSession);
          return send(200,{data:{organizationId,sessionId:input.data.selectSession}});
        }
        const {serviceKey,restrictToOneSession}=input.data;
        if(serviceKey)await verifyDevinEventCredential(serviceKey,organizationId);
        if(!await canManage())fail(403,'Workspace admin required');
        await grants.set(principal.tenantId,organizationId,version,serviceKey,restrictToOneSession);
        return send(200,{data:{organizationId,enabled:serviceKey!==null}});
      }
      const identity=await options.workloads.identify(token);
      if(identity.status!==200)return send(identity.status,{error:{code:'DEVIN_SESSION_AUTH_REQUIRED'}});
      const input=startupInput.safeParse(await body());
      if(!input.success)fail(400,'Invalid startup request');
      const events=await readDevinStartupEvents({audience:options.audience,workloads:options.workloads,...options.startup,
        sessionAllowed:async(p,id)=>!(await controls.read(p,'sessions','devin',id))?.deletedAt,
        grant:grants.read},identity.principal,input.data.installationId,input.data.through);
      return send(200,{data:{sessionId:identity.workload.sessionId,events}});
    } catch(error) {
      const {status,code}=errorInfo(error);
      return send(status&&[400,401,403,404,405,409,412,502].includes(status)?status:503,
        {error:{code:code==='DEVIN_SESSION_PRIVATE'?code:'DEVIN_EVENT_ACCESS_UNAVAILABLE'}});
    }
  };
}
