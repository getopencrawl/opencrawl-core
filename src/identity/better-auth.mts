import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {betterAuth} from 'better-auth';
import {organization,jwt} from 'better-auth/plugins';
import {getMigrations} from 'better-auth/db/migration';
import {oauthProvider,oauthDeviceAuthorization} from '@better-auth/oauth-provider';
import {createLocalJWKSet,type JWTVerifyGetKey,type JSONWebKeySet} from 'jose';
import type {IdentityDirectory,DirectoryMembership,HostedUser} from './types.mjs';

/** Pre-registered public client used by `opencrawl login` (RFC 8628 device grant). */
export const CLI_CLIENT_ID='opencrawl-cli';
const INVITATION_TTL=7*86400_000;
const PREFIX:Record<string,string>={user:'user_',organization:'org_',member:'om_',invitation:'invitation_'};
const fail=(status:number,message:string):never=>{throw Object.assign(new Error(message),{status,expose:true});};
interface UserRow {id:string;email:string;name:string;emailVerified:boolean}
interface MemberRow {id:string;organizationId:string;userId:string;role:string}
interface InvitationRow {id:string;organizationId:string;email:string;role:string;status:string;expiresAt:Date|string}
interface SessionRow {id:string;userId:string;expiresAt:Date|string}

export interface LocalIdentityOptions {url:string;secret:string;databasePath:string;organizationId:string}
/**
 * Operator-free identity for one self-hosted organization: email/password accounts,
 * invitations, browser sessions, the CLI device grant and the MCP authorization
 * server all live in this installation's own database. Ids keep the `user_`/`org_`
 * shapes that storage scopes and authorization already validate.
 */
export function createLocalIdentity({url,secret,databasePath,organizationId}:LocalIdentityOptions){
  if(!/^org_[A-Za-z0-9]+$/.test(organizationId))throw new Error('Configure one organization');
  const resource=url+'/mcp';
  const auth=betterAuth({
    appName:'OpenCrawl',baseURL:url,basePath:'/api/auth',secret,database:new DatabaseSync(databasePath),
    telemetry:{enabled:false},logger:{level:'error'},
    emailAndPassword:{enabled:true,minPasswordLength:10,autoSignIn:true},
    session:{expiresIn:7*86400,updateAge:86400},
    advanced:{database:{generateId:({model})=>(PREFIX[model]||'')+randomBytes(16).toString('hex')}},
    plugins:[
      organization(),
      jwt({jwks:{keyPairConfig:{alg:'RS256',modulusLength:2048}}}),
      // MCP clients register dynamically and must show this deployment's consent page.
      oauthProvider({loginPage:'/auth/login',consentPage:'/auth/consent',resources:[resource],enforcePerClientResources:false,
        allowDynamicClientRegistration:true,allowUnauthenticatedClientRegistration:true,clientRegistrationDefaultApplicationType:'infer',scopes:['openid','profile','email','offline_access']}),
      oauthDeviceAuthorization({verificationUri:'/device'}),
    ],
  });
  const adapter=async()=>(await auth.$context).adapter;
  const user=(row:UserRow):HostedUser=>{const [firstName,...rest]=row.name.trim().split(/\s+/);return {id:row.id,email:row.email,emailVerified:row.emailVerified===true,firstName:firstName||null,lastName:rest.join(' ')||null};};
  // Better Auth's owner role is this product's admin role; members never hold more.
  const membership=(row:MemberRow):DirectoryMembership=>{const slug=row.role==='owner'||row.role==='admin'?'admin':'member';return {id:row.id,userId:row.userId,organizationId:row.organizationId,status:'active',role:{slug},roles:[{slug}]};};
  const live=(row:InvitationRow)=>row.status==='pending'&&new Date(row.expiresAt).getTime()>Date.now();
  const ownOrganization=(id:string)=>{if(id!==organizationId)fail(403,'Workspace access denied');};

  const directory:IdentityDirectory={
    userManagement:{
      async getUser(id){
        const row=await (await adapter()).findOne<UserRow>({model:'user',where:[{field:'id',value:id}]});
        return row?user(row):fail(404,'User not found');
      },
      async listOrganizationMemberships({userId,organizationId:org}){
        const where=[...(userId?[{field:'userId',value:userId}]:[]),...(org?[{field:'organizationId',value:org}]:[])];
        const rows=await (await adapter()).findMany<MemberRow>({model:'member',where,limit:1000});
        return {data:rows.map(membership)};
      },
      async listSessions(userId){
        const rows=await (await adapter()).findMany<SessionRow>({model:'session',where:[{field:'userId',value:userId}],limit:1000});
        return {data:rows.map(row=>({id:row.id,userId:row.userId,status:new Date(row.expiresAt).getTime()>Date.now()?'active':'expired',endedAt:null,expiresAt:new Date(row.expiresAt).toISOString()})),listMetadata:{after:null}};
      },
      async updateOrganizationMembership(id,{roleSlug}){
        if(roleSlug!=='admin'&&roleSlug!=='member')fail(400,'Choose Admin or Member.');
        const row=await (await adapter()).update<MemberRow>({model:'member',where:[{field:'id',value:id}],update:{role:roleSlug}});
        return row?membership(row):fail(404,'Membership not found');
      },
      async listInvitations({organizationId:org}){
        ownOrganization(org);
        const rows=await (await adapter()).findMany<InvitationRow>({model:'invitation',where:[{field:'organizationId',value:org}],limit:1000});
        return {data:rows.map(row=>({email:row.email,state:live(row)?'pending':row.status,organizationId:row.organizationId}))};
      },
      async sendInvitation({organizationId:org,email,inviterUserId,roleSlug}){
        ownOrganization(org);
        const db=await adapter(),address=email.trim().toLowerCase();
        const existing=await db.findOne<UserRow>({model:'user',where:[{field:'email',value:address}]});
        if(existing&&await db.findOne<MemberRow>({model:'member',where:[{field:'userId',value:existing.id},{field:'organizationId',value:org}]}))fail(409,'That teammate is already a member.');
        const pending=(await db.findMany<InvitationRow>({model:'invitation',where:[{field:'organizationId',value:org},{field:'email',value:address}]})).find(live);
        if(pending)return {id:pending.id,email:address,acceptInvitationUrl:invitationUrl(pending.id)};
        const row=await db.create<Omit<InvitationRow,'id'>&{inviterId:string;createdAt:Date},InvitationRow>({model:'invitation',data:{organizationId:org,email:address,role:roleSlug==='admin'?'admin':'member',status:'pending',expiresAt:new Date(Date.now()+INVITATION_TTL),inviterId:inviterUserId,createdAt:new Date()}});
        return {id:row.id,email:address,acceptInvitationUrl:invitationUrl(row.id)};
      },
    },
    organizations:{
      async getOrganization(id){
        ownOrganization(id);
        const row=await (await adapter()).findOne<{id:string;name:string}>({model:'organization',where:[{field:'id',value:id}]});
        return row?{id:row.id,name:row.name}:fail(404,'Organization not found');
      },
      async updateOrganization({organization:id,name}){
        ownOrganization(id);
        const row=await (await adapter()).update<{id:string;name:string}>({model:'organization',where:[{field:'id',value:id}],update:{name}});
        return row?{id:row.id,name:row.name}:fail(404,'Organization not found');
      },
    },
  };
  const invitationUrl=(id:string)=>`${url}/auth/signup?invitation=${encodeURIComponent(id)}`;

  /** Schema migration and idempotent seed of the organization and CLI client. */
  async function ready(){
    await (await getMigrations(auth.options)).runMigrations();
    const db=await adapter();
    if(!await db.findOne({model:'organization',where:[{field:'id',value:organizationId}]}))
      await db.create({model:'organization',data:{id:organizationId,name:'OpenCrawl',slug:organizationId.toLowerCase().replaceAll('_','-'),createdAt:new Date()},forceAllowId:true});
    if(!await db.findOne({model:'oauthClient',where:[{field:'clientId',value:CLI_CLIENT_ID}]}))
      await db.create({model:'oauthClient',data:{clientId:CLI_CLIENT_ID,name:'OpenCrawl CLI',tokenEndpointAuthMethod:'none',grantTypes:['urn:ietf:params:oauth:grant-type:device_code','refresh_token'],
        responseTypes:[],redirectUris:[],scopes:['openid','profile','email','offline_access'],skipConsent:true,requirePKCE:false,disabled:false,createdAt:new Date(),updatedAt:new Date()}});
  }
  /** First run: no member exists until the operator creates the first admin. */
  async function setupRequired(){return (await (await adapter()).count({model:'member',where:[{field:'organizationId',value:organizationId}]}))===0;}
  async function pendingInvitation(id:string){
    const row=await (await adapter()).findOne<InvitationRow>({model:'invitation',where:[{field:'id',value:id}]});
    return row&&row.organizationId===organizationId&&live(row)?row:null;
  }
  /** Possession of the setup link or an invitation link verifies the address in place of email delivery. */
  async function admitAccount(userId:string,role:'admin'|'member',invitationId?:string){
    const db=await adapter();
    await db.update({model:'user',where:[{field:'id',value:userId}],update:{emailVerified:true}});
    if(!await db.findOne({model:'member',where:[{field:'userId',value:userId},{field:'organizationId',value:organizationId}]}))
      await db.create({model:'member',data:{organizationId,userId,role,createdAt:new Date()}});
    if(invitationId)await db.update({model:'invitation',where:[{field:'id',value:invitationId}],update:{status:'accepted'}});
  }
  /** Pending invitation links by email, for the admin-only Team view. */
  async function invitationLinks(){
    const rows=await (await adapter()).findMany<InvitationRow>({model:'invitation',where:[{field:'organizationId',value:organizationId}],limit:1000});
    return new Map(rows.filter(live).map(row=>[row.email.toLowerCase(),invitationUrl(row.id)]));
  }
  async function renameOrganization(name:string){await directory.organizations.updateOrganization({organization:organizationId,name});}

  let keys:{set:JWTVerifyGetKey;at:number}|undefined;
  /** Access-token keys come from this process; no request to its own public origin. */
  const keyResolver:JWTVerifyGetKey=async(header,token)=>{
    if(!keys||Date.now()-keys.at>300_000)keys={set:createLocalJWKSet(await auth.api.getJwks() as JSONWebKeySet),at:Date.now()};
    try{return await keys.set(header,token);}catch{keys={set:createLocalJWKSet(await auth.api.getJwks() as JSONWebKeySet),at:Date.now()};return keys.set(header,token);}
  };
  return {auth,directory,ready,setupRequired,pendingInvitation,admitAccount,invitationLinks,renameOrganization,keyResolver,resource,issuer:url+'/api/auth'};
}
export type LocalIdentity=ReturnType<typeof createLocalIdentity>;
