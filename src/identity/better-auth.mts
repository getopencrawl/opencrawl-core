import type {PoolClient} from 'pg';
import type {ApplicationDatabase} from '../state/postgres.mjs';
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

export interface LocalIdentityOptions {url:string;secret:string;database:ApplicationDatabase;organizationId:string}
/**
 * Operator-free identity for one self-hosted organization: email/password accounts,
 * invitations, browser sessions, the CLI device grant and the MCP authorization
 * server all live in this installation's own database. Ids keep the `user_`/`org_`
 * shapes that storage scopes and authorization already validate.
 */
export async function identityOptions({url,secret,database,organizationId}:LocalIdentityOptions){
  if(!/^org_[A-Za-z0-9]+$/.test(organizationId))throw new Error('Configure one organization');
  const resource=url+'/mcp';
  const options={
    appName:'OpenCrawl',baseURL:url,basePath:'/api/auth',secret,database:database.identityPool,
    telemetry:{enabled:false},logger:{level:'error'},
    rateLimit:{enabled:true,storage:'database'},
    account:{accountLinking:{enabled:false}},
    emailAndPassword:{enabled:true,minPasswordLength:10,autoSignIn:true},
    session:{expiresIn:30*86400,updateAge:86400},
    advanced:{ipAddress:{ipAddressHeaders:['x-opencrawl-client-ip']},database:{generateId:({model})=>(PREFIX[model]||'')+randomBytes(16).toString('hex')}},
    plugins:[
      organization(),
      jwt({disableSettingJwtHeader:true,jwks:{keyPairConfig:{alg:'RS256',modulusLength:2048}}}),
      // MCP clients register dynamically and must show this deployment's consent page.
      // Many agents share an office IP. Keep a bounded token budget without
      // applying the provider's 20/min default to every independent MCP session.
      // Offline CLI/MCP grants renew for 90 days; short access tokens still expire hourly.
      oauthProvider({accessTokenExpiresIn:3600,refreshTokenExpiresIn:90*86400,rateLimit:{token:{window:60,max:120}},loginPage:'/auth/login',consentPage:'/auth/consent',resources:[resource],enforcePerClientResources:false,
        allowDynamicClientRegistration:true,allowUnauthenticatedClientRegistration:true,clientRegistrationDefaultApplicationType:'infer',scopes:['openid','profile','email','offline_access']}),
      oauthDeviceAuthorization({verificationUri:'/device'}),
    ],
  } satisfies BetterAuthOptions;
  return options;
}

/** The provider schema and its extension tables live in the namespace-bound auth schema.
 * This prepares an empty target for offline import; it never creates accounts or grants. */
export async function ensureIdentitySchema(options:LocalIdentityOptions){
  const config=await identityOptions(options),{database}=options;
  await database.ready();
  await database.transaction(async client=>{
    // Native Kysely introspects every visible schema before selecting this one.
    // Coordinate namespace retirement with that catalog read, too.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:identity-schema:maintenance',0))");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[database.identitySchema+':schema']);
    await (await getMigrations(config)).runMigrations();
    await database.identityPool.query(`CREATE TABLE IF NOT EXISTS "opencrawlIdentityBinding" (singleton integer PRIMARY KEY CHECK(singleton=1), "organizationId" text NOT NULL);
      CREATE TABLE IF NOT EXISTS "opencrawlIdentityState" ("organizationId" text PRIMARY KEY, initialized integer NOT NULL CHECK(initialized IN (0,1)));
      CREATE TABLE IF NOT EXISTS "opencrawlAccountEpoch" ("userId" text PRIMARY KEY, "notBefore" bigint NOT NULL)`);
  });
  return config;
}

export async function createLocalIdentity(input:LocalIdentityOptions){
  const {url,database,organizationId}=input,resource=url+'/mcp';
  const options=await ensureIdentitySchema(input),auth=betterAuth(options);
  async function transaction<T>(run:(client:PoolClient)=>Promise<T>):Promise<T>{
    const client=await database.identityPool.connect();let broken=false;
    try {await client.query('BEGIN');const result=await run(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK').catch(()=>{broken=true;});throw error;}
    finally {client.release(broken);}
  }
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
        await transaction(async client=>{
          const {rows}=await client.query<{userId:string;email:string}>('SELECT member."userId", "user".email FROM member JOIN "user" ON member."userId"="user".id WHERE member.id=$1 AND member."organizationId"=$2 FOR UPDATE OF member',[id,organizationId]);
          const row=rows[0];if(!row)fail(404,'Membership not found');
          await client.query('DELETE FROM member WHERE id=$1 AND "organizationId"=$2',[id,organizationId]);
          await client.query(`UPDATE invitation SET status='canceled' WHERE "organizationId"=$1 AND lower(email)=lower($2) AND status='pending'`,[organizationId,row!.email]);
          await revokeLocalCredentials(client,row!.userId);
        });
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
    await database.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[database.identitySchema+':bootstrap']);
      await database.identityPool.query('INSERT INTO "opencrawlIdentityBinding" (singleton,"organizationId") VALUES (1,$1) ON CONFLICT(singleton) DO NOTHING',[organizationId]);
      const {rows}=await database.identityPool.query<{organizationId:string}>('SELECT "organizationId" FROM "opencrawlIdentityBinding" WHERE singleton=1');
      if(rows[0]?.organizationId!==organizationId)throw new Error('Identity database belongs to a different organization');
      const db=await adapter();
      if(!await db.findOne({model:'organization',where:[{field:'id',value:organizationId}]}))
        await db.create({model:'organization',data:{id:organizationId,name:'OpenCrawl',slug:organizationId.toLowerCase().replaceAll('_','-'),createdAt:new Date()},forceAllowId:true});
      if(!await db.findOne({model:'oauthClient',where:[{field:'clientId',value:CLI_CLIENT_ID}]}))
        await db.create({model:'oauthClient',data:{clientId:CLI_CLIENT_ID,name:'OpenCrawl CLI',tokenEndpointAuthMethod:'none',grantTypes:['urn:ietf:params:oauth:grant-type:device_code','refresh_token'],
          responseTypes:[],redirectUris:[],scopes:['openid','profile','email','offline_access'],skipConsent:true,requirePKCE:false,disabled:false,createdAt:new Date(),updatedAt:new Date()}});
    });
  }
  /** The durable initialization marker prevents enrollment reopening after removal. */
  async function setupRequired(){
    const {rowCount}=await database.identityPool.query('SELECT 1 FROM "opencrawlIdentityState" WHERE "organizationId"=$1 AND initialized=1',[organizationId]);
    return !rowCount&&(await (await adapter()).count({model:'member',where:[{field:'organizationId',value:organizationId}]}))===0;
  }
  async function pendingInvitation(id:string){
    const row=await (await adapter()).findOne<InvitationRow>({model:'invitation',where:[{field:'id',value:id}]});
    return row&&row.organizationId===organizationId&&live(row)?row:null;
  }
  /** Operator-controlled enrollment authorizes a local account; it does not verify its mailbox. */
  async function admitAccount(userId:string,role:'admin'|'member',invitationId?:string,workspace?:string){
    await transaction(async client=>{
      // Serialize first-admin and invitation consumption within this organization.
      await client.query('SELECT id FROM organization WHERE id=$1 FOR UPDATE',[organizationId]);
      const account=(await client.query<{email:string}>('SELECT email FROM "user" WHERE id=$1',[userId])).rows[0];
      if(!account)fail(404,'Account not found');
      if(invitationId){
        const invite=(await client.query<InvitationRow>('SELECT * FROM invitation WHERE id=$1 AND "organizationId"=$2 FOR UPDATE',[invitationId,organizationId])).rows[0];
        if(!invite||invite.status!=='pending'||!Number.isFinite(new Date(invite.expiresAt).getTime())||new Date(invite.expiresAt).getTime()<=Date.now()||invite.email!==account!.email)fail(410,'Invitation unavailable');
        role=invite!.role==='admin'?'admin':'member';
      }else{
        if((await client.query('SELECT 1 FROM "opencrawlIdentityState" WHERE "organizationId"=$1 AND initialized=1',[organizationId])).rowCount||
          (await client.query('SELECT 1 FROM member WHERE "organizationId"=$1 LIMIT 1',[organizationId])).rowCount)fail(403,'Workspace is already initialized');
        await client.query('INSERT INTO "opencrawlIdentityState" ("organizationId",initialized) VALUES ($1,1)',[organizationId]);
        role='admin';
        if(workspace)await client.query('UPDATE organization SET name=$1 WHERE id=$2',[workspace,organizationId]);
      }
      if(!(await client.query('SELECT 1 FROM member WHERE "userId"=$1 AND "organizationId"=$2',[userId,organizationId])).rowCount)
        await client.query('INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,$4,$5)',['om_'+randomBytes(16).toString('hex'),organizationId,userId,role,new Date()]);
      if(invitationId)await client.query(`UPDATE invitation SET status='accepted' WHERE id=$1`,[invitationId]);
    });
  }
  /** Pending invitation links by email, for the admin-only Team view. */
  async function invitationLinks(){
    const rows=await (await adapter()).findMany<InvitationRow>({model:'invitation',where:[{field:'organizationId',value:organizationId}],limit:1000});
    return new Map(rows.filter(live).map(row=>[row.email.toLowerCase(),invitationUrl(row.id)]));
  }
  async function renameOrganization(name:string){await directory.organizations.updateOrganization({organization:organizationId,name});}

  /** Account mutation and local credential invalidation commit together. */
  async function revokeLocalCredentials(client:PoolClient,userId:string){
    for(const table of ['session','oauthAccessToken','oauthRefreshToken','deviceCode','oauthConsent'])
      await client.query(`DELETE FROM "${table}" WHERE "userId"=$1`,[userId]);
    // Verification also holds non-JSON tokens. Parse only candidate authorization
    // codes without ever casting malformed provider values inside SQL.
    const {rows}=await client.query<{id:string;value:string}>('SELECT id,value FROM verification WHERE value LIKE $1',['%"authorization_code"%']);
    const ids=rows.flatMap(row=>{try {const value=JSON.parse(row.value);return value?.type==='authorization_code'&&value.userId===userId?[row.id]:[];}catch{return [];}});
    if(ids.length)await client.query('DELETE FROM verification WHERE id=ANY($1::text[])',[ids]);
    await client.query('INSERT INTO "opencrawlAccountEpoch" ("userId","notBefore") VALUES ($1,$2) ON CONFLICT("userId") DO UPDATE SET "notBefore"=EXCLUDED."notBefore"',[userId,Math.floor(Date.now()/1000)+1]);
  }

  /** Operator-only recovery, never exposed as an HTTP route. Passwords stay off argv/logs. */
  async function recoverPassword(email:string,password:string){
    if(password.length<10||password.length>128)fail(400,'Use a password of 10 to 128 characters');
    const hash=await (await auth.$context).password.hash(password);
    await transaction(async client=>{
      const row=(await client.query<{id:string}>('SELECT "user".id FROM "user" JOIN member ON member."userId"="user".id WHERE lower("user".email)=$1 AND member."organizationId"=$2 FOR UPDATE OF "user",member',[email.trim().toLowerCase(),organizationId])).rows[0];
      if(!row)fail(404,'No enrolled account has that email');
      const result=await client.query(`UPDATE account SET password=$1,"updatedAt"=$2 WHERE "userId"=$3 AND "providerId"='credential'`,[hash,new Date(),row!.id]);
      if(result.rowCount!==1)fail(409,'Expected one password account');
      await revokeLocalCredentials(client,row!.id);
    });
  }
  const tokenCurrent=async(userId:string,issuedAt:number)=>{
    const row=(await database.identityPool.query<{notBefore:string}>('SELECT "notBefore" FROM "opencrawlAccountEpoch" WHERE "userId"=$1',[userId])).rows[0];
    return !row||issuedAt>=Number(row.notBefore);
  };

  let keys:{set:JWTVerifyGetKey;at:number}|undefined;
  /** Access-token keys come from this process; no request to its own public origin. */
  const keyResolver:JWTVerifyGetKey=async(header,token)=>{
    if(!keys||Date.now()-keys.at>300_000)keys={set:createLocalJWKSet(await auth.api.getJwks() as JSONWebKeySet),at:Date.now()};
    try{return await keys.set(header,token);}catch{keys={set:createLocalJWKSet(await auth.api.getJwks() as JSONWebKeySet),at:Date.now()};return keys.set(header,token);}
  };
  return {auth,directory,close:()=>{},ready,setupRequired,pendingInvitation,admitAccount,invitationLinks,renameOrganization,recoverPassword,tokenCurrent,keyResolver,resource,issuer:url+'/api/auth'};
}
export type LocalIdentity=Awaited<ReturnType<typeof createLocalIdentity>>;
