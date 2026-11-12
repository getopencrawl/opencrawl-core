import {DatabaseSync} from 'node:sqlite';
import {chmodSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {betterAuth,type BetterAuthOptions} from 'better-auth';
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
export async function createLocalIdentity({url,secret,databasePath,organizationId}:LocalIdentityOptions){
  if(!/^org_[A-Za-z0-9]+$/.test(organizationId))throw new Error('Configure one organization');
  const resource=url+'/mcp',database=new DatabaseSync(databasePath);
  if(databasePath!==':memory:')chmodSync(databasePath,0o600);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const options={
    appName:'OpenCrawl',baseURL:url,basePath:'/api/auth',secret,database,
    telemetry:{enabled:false},logger:{level:'error'},
    rateLimit:{enabled:true,storage:'database'},
    account:{accountLinking:{enabled:false}},
    emailAndPassword:{enabled:true,minPasswordLength:10,autoSignIn:true},
    session:{expiresIn:7*86400,updateAge:86400},
    advanced:{ipAddress:{ipAddressHeaders:['x-opencrawl-client-ip']},database:{generateId:({model})=>(PREFIX[model]||'')+randomBytes(16).toString('hex')}},
    plugins:[
      organization(),
      jwt({disableSettingJwtHeader:true,jwks:{keyPairConfig:{alg:'RS256',modulusLength:2048}}}),
      // MCP clients register dynamically and must show this deployment's consent page.
      // Many agents share an office IP. Keep a bounded token budget without
      // applying the provider's 20/min default to every independent MCP session.
      oauthProvider({accessTokenExpiresIn:3600,rateLimit:{token:{window:60,max:120}},loginPage:'/auth/login',consentPage:'/auth/consent',resources:[resource],enforcePerClientResources:false,
        allowDynamicClientRegistration:true,allowUnauthenticatedClientRegistration:true,clientRegistrationDefaultApplicationType:'infer',scopes:['openid','profile','email','offline_access']}),
      oauthDeviceAuthorization({verificationUri:'/device'}),
    ],
  } satisfies BetterAuthOptions;
  try{await (await getMigrations(options)).runMigrations();}catch(error){database.close();throw error;}
  const auth=betterAuth(options);
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
        if(!row)return fail(404,'User not found');
        const enrolled=await (await adapter()).findOne<MemberRow>({model:'member',where:[{field:'userId',value:id},{field:'organizationId',value:organizationId}]});
        return {...user(row),locallyEnrolled:Boolean(enrolled)};
      },
      async listOrganizationMemberships({userId,organizationId:org,statuses}){
        if(org&&org!==organizationId||statuses&&!statuses.includes('active'))return {data:[]};
        org=organizationId;
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
        const row=await (await adapter()).update<MemberRow>({model:'member',where:[{field:'id',value:id},{field:'organizationId',value:organizationId}],update:{role:roleSlug}});
        return row?membership(row):fail(404,'Membership not found');
      },
      async deleteOrganizationMembership(id){
        database.exec('BEGIN IMMEDIATE');
        try{
          const row=database.prepare('SELECT member.userId,user.email FROM member JOIN user ON member.userId=user.id WHERE member.id=? AND member.organizationId=?').get(id,organizationId);
          if(!row||typeof row.userId!=='string')fail(404,'Membership not found');
          const userId=String(row!.userId);
          database.prepare('DELETE FROM member WHERE id=? AND organizationId=?').run(id,organizationId);
          database.prepare("UPDATE invitation SET status='canceled' WHERE organizationId=? AND lower(email)=lower(?) AND status='pending'").run(organizationId,String(row!.email));
          revokeLocalCredentials(userId);
          database.exec('COMMIT');
        }catch(error){database.exec('ROLLBACK');throw error;}
      },
      async listInvitations({organizationId:org}){
        ownOrganization(org);
        const rows=await (await adapter()).findMany<InvitationRow>({model:'invitation',where:[{field:'organizationId',value:org}],limit:1000});
        return {data:rows.map(row=>({email:row.email,state:live(row)?'pending':row.status==='pending'?'expired':row.status,organizationId:row.organizationId,...(live(row)?{acceptInvitationUrl:invitationUrl(row.id)}:{})}))};
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
    database.exec('CREATE TABLE IF NOT EXISTS opencrawlIdentityBinding (singleton INTEGER PRIMARY KEY CHECK(singleton=1), organizationId TEXT NOT NULL)');
    database.prepare('INSERT OR IGNORE INTO opencrawlIdentityBinding (singleton,organizationId) VALUES (1,?)').run(organizationId);
    if(database.prepare('SELECT organizationId FROM opencrawlIdentityBinding WHERE singleton=1').get()?.organizationId!==organizationId)
      throw new Error('Identity database belongs to a different organization');
    database.exec('CREATE TABLE IF NOT EXISTS opencrawlIdentityState (organizationId TEXT PRIMARY KEY, initialized INTEGER NOT NULL)');
    database.exec('CREATE TABLE IF NOT EXISTS opencrawlAccountEpoch (userId TEXT PRIMARY KEY, notBefore INTEGER NOT NULL)');
    const db=await adapter();
    if(!await db.findOne({model:'organization',where:[{field:'id',value:organizationId}]}))
      await db.create({model:'organization',data:{id:organizationId,name:'OpenCrawl',slug:organizationId.toLowerCase().replaceAll('_','-'),createdAt:new Date()},forceAllowId:true});
    if(!await db.findOne({model:'oauthClient',where:[{field:'clientId',value:CLI_CLIENT_ID}]}))
      await db.create({model:'oauthClient',data:{clientId:CLI_CLIENT_ID,name:'OpenCrawl CLI',tokenEndpointAuthMethod:'none',grantTypes:['urn:ietf:params:oauth:grant-type:device_code','refresh_token'],
        responseTypes:[],redirectUris:[],scopes:['openid','profile','email','offline_access'],skipConsent:true,requirePKCE:false,disabled:false,createdAt:new Date(),updatedAt:new Date()}});
  }
  /** First run: no member exists until the operator creates the first admin. */
  async function setupRequired(){return !database.prepare('SELECT 1 FROM opencrawlIdentityState WHERE organizationId=? AND initialized=1').get(organizationId)&&
    (await (await adapter()).count({model:'member',where:[{field:'organizationId',value:organizationId}]}))===0;}
  async function pendingInvitation(id:string){
    const row=await (await adapter()).findOne<InvitationRow>({model:'invitation',where:[{field:'id',value:id}]});
    return row&&row.organizationId===organizationId&&live(row)?row:null;
  }
  /** Operator-controlled enrollment authorizes a local account; it does not verify its mailbox. */
  async function admitAccount(userId:string,role:'admin'|'member',invitationId?:string,workspace?:string){
    // This pinned adapter owns the SQLite mapping. A synchronous transaction
    // makes consuming a grant and adding its member atomic across processes.
    database.exec('BEGIN IMMEDIATE');
    try {
      const account=database.prepare('SELECT email FROM user WHERE id=?').get(userId);
      if(!account)fail(404,'Account not found');
      if(invitationId){
        const invite=database.prepare('SELECT * FROM invitation WHERE id=? AND organizationId=?').get(invitationId,organizationId);
        const expiresAt=typeof invite?.expiresAt==='string'?Date.parse(invite.expiresAt):Number(invite?.expiresAt);
        if(!invite||invite.status!=='pending'||!Number.isFinite(expiresAt)||expiresAt<=Date.now()||invite.email!==account!.email)fail(410,'Invitation unavailable');
        role=invite!.role==='admin'?'admin':'member';
      }else{
        if(database.prepare('SELECT 1 FROM opencrawlIdentityState WHERE organizationId=? AND initialized=1').get(organizationId)||
          database.prepare('SELECT 1 FROM member WHERE organizationId=? LIMIT 1').get(organizationId))fail(403,'Workspace is already initialized');
        database.prepare('INSERT INTO opencrawlIdentityState (organizationId,initialized) VALUES (?,1)').run(organizationId);
        role='admin';
        if(workspace)database.prepare('UPDATE organization SET name=? WHERE id=?').run(workspace,organizationId);
      }
      if(!database.prepare('SELECT 1 FROM member WHERE userId=? AND organizationId=?').get(userId,organizationId))
        database.prepare('INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES (?,?,?,?,?)').run('om_'+randomBytes(16).toString('hex'),organizationId,userId,role,Date.now());
      if(invitationId)database.prepare("UPDATE invitation SET status='accepted' WHERE id=?").run(invitationId);
      database.exec('COMMIT');
    }catch(error){database.exec('ROLLBACK');throw error;}
  }
  /** Pending invitation links by email, for the admin-only Team view. */
  async function invitationLinks(){
    const rows=await (await adapter()).findMany<InvitationRow>({model:'invitation',where:[{field:'organizationId',value:organizationId}],limit:1000});
    return new Map(rows.filter(live).map(row=>[row.email.toLowerCase(),invitationUrl(row.id)]));
  }
  async function renameOrganization(name:string){await directory.organizations.updateOrganization({organization:organizationId,name});}

  /** Called inside a transaction with the account or membership change. */
  function revokeLocalCredentials(userId:string){
    database.prepare('DELETE FROM session WHERE userId=?').run(userId);
    database.prepare('DELETE FROM oauthAccessToken WHERE userId=?').run(userId);
    database.prepare('DELETE FROM oauthRefreshToken WHERE userId=?').run(userId);
    database.prepare('DELETE FROM deviceCode WHERE userId=?').run(userId);
    database.prepare('DELETE FROM oauthConsent WHERE userId=?').run(userId);
    database.prepare(`DELETE FROM verification WHERE CASE WHEN json_valid(value) THEN
      json_extract(value,'$.type')='authorization_code'
      AND json_extract(value,'$.userId')=? ELSE 0 END`).run(userId);
    database.prepare('INSERT INTO opencrawlAccountEpoch (userId,notBefore) VALUES (?,?) ON CONFLICT(userId) DO UPDATE SET notBefore=excluded.notBefore').run(userId,Math.floor(Date.now()/1000)+1);
  }

  /** Operator-only recovery, never exposed as an HTTP route. Passwords stay off argv/logs. */
  async function recoverPassword(email:string,password:string){
    if(password.length<10||password.length>128)fail(400,'Use a password of 10 to 128 characters');
    const row=database.prepare('SELECT user.id FROM user JOIN member ON member.userId=user.id WHERE lower(user.email)=? AND member.organizationId=?').get(email.trim().toLowerCase(),organizationId);
    if(!row||typeof row.id!=='string')fail(404,'No enrolled account has that email');
    const userId=String(row!.id),hash=await (await auth.$context).password.hash(password);
    database.exec('BEGIN IMMEDIATE');
    try {
      const result=database.prepare("UPDATE account SET password=?, updatedAt=? WHERE userId=? AND providerId='credential'").run(hash,Date.now(),userId);
      if(result.changes!==1)fail(409,'Expected one password account');
      revokeLocalCredentials(userId);
      database.exec('COMMIT');
    }catch(error){database.exec('ROLLBACK');throw error;}
  }
  const tokenCurrent=(userId:string,issuedAt:number)=>{
    const row=database.prepare('SELECT notBefore FROM opencrawlAccountEpoch WHERE userId=?').get(userId);
    return !row||issuedAt>=Number(row.notBefore);
  };

  let keys:{set:JWTVerifyGetKey;at:number}|undefined;
  /** Access-token keys come from this process; no request to its own public origin. */
  const keyResolver:JWTVerifyGetKey=async(header,token)=>{
    if(!keys||Date.now()-keys.at>300_000)keys={set:createLocalJWKSet(await auth.api.getJwks() as JSONWebKeySet),at:Date.now()};
    try{return await keys.set(header,token);}catch{keys={set:createLocalJWKSet(await auth.api.getJwks() as JSONWebKeySet),at:Date.now()};return keys.set(header,token);}
  };
  return {auth,directory,close:()=>database.close(),ready,setupRequired,pendingInvitation,admitAccount,invitationLinks,renameOrganization,recoverPassword,tokenCurrent,keyResolver,resource,issuer:url+'/api/auth'};
}
export type LocalIdentity=Awaited<ReturnType<typeof createLocalIdentity>>;
