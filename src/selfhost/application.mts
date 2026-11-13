import type {EventIdentityStore} from '../sessions/types.mjs';
import {createReplicasWorkloads, isReplicasToken, isWorkloadPrincipal} from '../identity/replicas.mjs';
import type {createSlackOAuth} from '../integrations/slack-oauth.mjs';
import {connectorProxyHandler,type SourceCredentialProxy} from '../integrations/proxy-http.mjs';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Principal} from '../identity/types.mjs';
import type {SelfhostSettings} from './settings.mjs';
import type {createObjectStore} from '../sessions/s3-store.mjs';
import type {Integrations} from '../integrations/service.mjs';
import type {ProviderCatalog} from '../integrations/types.mjs';
import type {createConnectorResolver} from '../integrations/resolver.mjs';
import type {LocalIdentity} from '../identity/better-auth.mjs';
import {localAuth} from './local-auth.mjs';
import {Readable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {currentVerifiedUser} from '../identity/auth.mjs';
import {singleOrganizationIdentity} from '../identity/single-organization.mjs';
import {singleOrganizationPrincipal} from '../identity/principal.mjs';
import {mcpMetadata} from '../identity/mcp.mjs';
import {teamService,isAdmin} from '../identity/team.mjs';
import {roleWriteGuard} from '../identity/role-write.mjs';
import {createOnboardingStatus} from '../onboarding-status.mjs';
import {deriveOnboarding,hasReceipt} from '../onboarding-state.mjs';
import {createOnboardingObserver} from '../application/onboarding-observer.mjs';
import {createGuidedOnboarding} from '../application/onboarding.mjs';
import {smallJson} from '../application/http.mjs';
import {createConsoleApi,consoleDocument,consolePages} from '../application/console.mjs';
import {productRoute,type Route} from '../application/routes.mjs';
import {productRouter,handleProductRpc,rpcError} from '../application/rpc.mjs';
import {usageReport} from '../application/usage.mjs';
import {valueReports} from '../application/value-report.mjs';
import {diagnosticRequest} from '../application/diagnostics.mjs';
import {integrationRequest} from '../application/integration-http.mjs';
import {securityHeaders,document} from '../application/presentation.mjs';
import {authorizedBoard} from '../application/board.mjs';
import {createBoardSearch} from '../board/search.mjs';
import {createBoardHandler} from '../board/http.mjs';
import {createOpenCrawlMcp} from '../mcp/server.mjs';
import {createSessionSearch} from '../sessions/search.mjs';
import {createRecentSessions} from '../sessions/recent.mjs';
import {createSessionLibrary} from '../sessions/library.mjs';
import {createMemoryLibrary} from '../memories/library.mjs';
import {createLibraryApi,libraryFailure} from '../sessions/library-http.mjs';
import {createWorkspaceSearch,createWorkspaceSearchHandler} from '../search/workspace.mjs';
import {captureSetupPrompt,cloudCapturePage} from '../sessions/cloud-setup.mjs';
import {createCaptureCredentials,isCaptureCredential} from '../sessions/credentials.mjs';
import {createSessionIngest,createCaptureHandler} from '../sessions/ingest.mjs';
import {errorInfo} from '../errors.mjs';
type Store=ReturnType<typeof createObjectStore>;
export interface SelfhostApplicationOptions {
  settings:SelfhostSettings;store:Store;eventIdentities?:EventIdentityStore;prefix:string;identity:LocalIdentity;
  integrations?:Integrations;providers?:ProviderCatalog;connectors?:ReturnType<typeof createConnectorResolver>;
  oauth?:ReturnType<typeof createSlackOAuth>;sourceCredentials?:SourceCredentialProxy;
  /** Lets an admin store an operator connector credential from the product. */
  connectorSettings?:{save(id:string,value:unknown,by:Principal):Promise<void>};
  scheduleSessionDeletion?:(key:string)=>Promise<unknown>;
  workloadIdentity?:ReturnType<typeof createReplicasWorkloads>;
  readAsset?:(file:string)=>Promise<string|Buffer>;
}
/** Full product composition for one self-hosted organization with its own accounts. */
export function selfhostApplication({settings,store,eventIdentities,prefix,identity,integrations,providers={},connectors,oauth,sourceCredentials=oauth,connectorSettings,scheduleSessionDeletion,workloadIdentity,
  readAsset=file=>readFile(new URL('../../../'+file,import.meta.url)),
}:SelfhostApplicationOptions) {
  const workloads=workloadIdentity??createReplicasWorkloads({audience:settings.url,bindings:()=>settings.replicasBindings??[]});
  const directory=identity.directory;
  const credentialProxy=sourceCredentials?connectorProxyHandler(sourceCredentials):null;
  const admit=singleOrganizationIdentity(directory,settings.organizationId),resolve=singleOrganizationPrincipal(directory,settings.organizationId);
  const accounts=localAuth({identity,url:settings.url,organizationId:settings.organizationId,setupToken:settings.setupToken,member:async browser=>(await admit(browser)).status===200});
  const credentials=createCaptureCredentials({store,prefix});
  const identifyCli=accounts.identifyToken,organizations=teamService(directory,roleWriteGuard(store,prefix),credentials.revokeAll);
  const onboarding=createOnboardingStatus({store,prefix}),observe=createOnboardingObserver(onboarding);
  const values=valueReports({store,prefix});
  const search=createSessionSearch({...settings.search,store,prefix});
  async function authorize(principal:Principal,requested?:unknown) {
    if(principal?.tenantId!==settings.organizationId || principal.captureAccess!==undefined || requested!=null&&requested!==settings.organizationId)throw Object.assign(new Error('Workspace access denied'),{status:403});
    if(isWorkloadPrincipal(principal))return workloads.revalidate(principal,requested);
    const current=await currentVerifiedUser(directory,principal.userId);
    if(current.status!==200)throw Object.assign(new Error('Account unavailable'),{status:current.status});
    const result=await resolve(current.user,settings.organizationId);
    if(!result)throw Object.assign(new Error('Membership required'),{status:403});
    return result;
  }
  const workspace=createWorkspaceSearch({sessions:search,connectors});
  const authorizedSearch={
    async search(p:Principal,input:unknown){await authorize(p);const result=await workspace.search(p,input);await authorize(p);return result;},
    async fetch(p:Principal,input:unknown){await authorize(p);const result=await workspace.fetch(p,input);await authorize(p);return result;},
  };
  const board=authorizedBoard({store,prefix:prefix+'/board',authorize,search:createBoardSearch(settings.search),recentSessions:createRecentSessions({store,prefix,...settings.search})});
  const identifyAgent=async(req:IncomingMessage)=>{const token=/^Bearer (.+)$/i.exec(req.headers.authorization||'')?.[1];return isReplicasToken(token)?workloads.identify(token):identifyCli(req.headers.authorization,{capture:true});};
  const authenticate=async(req:IncomingMessage)=>{const identity=await identifyAgent(req);if(identity.status!==200)throw Object.assign(new Error('Sign in required'),{status:identity.status});return identity.principal;};
  const query=createWorkspaceSearchHandler({search:authorizedSearch,authenticate});
  const fetchPassage=createWorkspaceSearchHandler({search:authorizedSearch,authenticate,operation:'fetch'});
  const boardHandler=createBoardHandler({board,authenticate});
  const mcp=createOpenCrawlMcp({origin:settings.url,revision:settings.revision,search:authorizedSearch,board,authenticate:async(req,res)=>{
    const token=/^Bearer (.+)$/i.exec(req.headers.authorization||'')?.[1];
    if(!isReplicasToken(token))return accounts.mcpIdentity(req,res);
    const result=await workloads.identify(token);if(result.status===200)return result.principal;
    res.writeHead(result.status,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'invalid_workload'}));return null;
  },onConnectionTest:async p=>{if(!isWorkloadPrincipal(p))await onboarding.mcpTest(p);},onAuthenticated:async(p,info)=>{if(!isWorkloadPrincipal(p))await onboarding.mcp(p,info);}});
  const capture=createCaptureHandler({credentials,search,ingest:createSessionIngest({store,eventIdentities,prefix,onStored:observe.session}),authenticate:async req=>{
    const token=/^Bearer (.+)$/.exec(req.headers.authorization||'')?.[1];
    if(isReplicasToken(token)){const result=await workloads.identify(token);if(result.status!==200)throw Object.assign(new Error('Workload authentication required'),{status:result.status});return {...result.principal,captureAccess:'write'};}
    if(isCaptureCredential(token)) {
      const delegated=await credentials.authenticate(token);
      if(!delegated)throw Object.assign(new Error('Capture credential expired or revoked'),{status:401});
      const principal=await authorize({tenantId:delegated.tenantId,userId:delegated.userId});
      if(req.method==='GET'&&req.url==='/api/sessions/identity')await observe.cli(principal);
      return {...principal,captureAccess:'write'};
    }
    const principal=await authenticate(req);
    if(req.method==='GET'&&req.url==='/api/sessions/identity')await observe.cli(principal);
    return principal;
  }});
  const guided=createGuidedOnboarding({onboarding,integrations,organizations,authorizedSearch,smallJson,inviteBeforeSetup:true});
  const library=createLibraryApi({sessions:createSessionLibrary({store,eventIdentities,prefix,...settings.search,scheduleDeletion:scheduleSessionDeletion}),memories:createMemoryLibrary({store,prefix,...settings.search})});
  const members=async(organizationId:string)=>{
    if(organizationId!==settings.organizationId)throw Object.assign(new Error('Workspace access denied'),{status:403});
    const result=await directory.userManagement.listOrganizationMemberships({organizationId,statuses:['active'],limit:100});
    const rows=result.autoPagination?await result.autoPagination():result.data;
    return [...new Map(rows.filter(m=>m.organizationId===organizationId&&m.status==='active').map(m=>[m.userId,m])).values()];
  };
  const assets=new Map<string,[string,string]>([
    ['/favicon.svg',['web/assets/opencrawl-mark.svg','image/svg+xml']],
    ...['tokens.css'].map((f):[string,[string,string]]=>['/'+f,['web/'+f,'text/css']]),
    ...['geist-sans.woff2','geist-mono.woff2','opencrawl-mark.svg'].map((f):[string,[string,string]]=>['/assets/'+f,['web/assets/'+f,f.endsWith('.svg')?'image/svg+xml':'font/woff2']]),
    ...['googledrive','slack','granola','circleback','notion','github'].flatMap(f=>['connectors','integrations'].map((kind):[string,[string,string]]=>[`/assets/${kind}/${f}.svg`,[`web/assets/connectors/${f}.svg`,'image/svg+xml']])),
  ]);
  return async(req:IncomingMessage,res:ServerResponse)=>{
    for(const [key,value] of Object.entries(securityHeaders))if(key!=='Strict-Transport-Security'||settings.url.startsWith('https:'))res.setHeader(key,key==='Content-Security-Policy'?value.replace(" https://api.workos.com https://*.authkit.app",''):value);
    const respond=(status:number,body:string|Buffer,type='text/plain; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type});res.end(body);};
    const json=(status:number,body:unknown)=>respond(status,JSON.stringify(body),'application/json');
    const redirect=(location:string)=>{res.writeHead(303,{Location:location});res.end();};
    const message=(status:number,heading:string,detail:string,href='/auth/login',action='Sign in')=>respond(status,document({kind:"message",heading,detail,href,action}),'text/html; charset=utf-8');
    try {
      const url=new URL(req.url||'/',settings.url);
      if(req.method==='GET'&&url.pathname==='/health')return json(200,{ok:true,mode:'selfhost',revision:settings.revision||'development'});
      if(url.pathname==='/.well-known/opencrawl-cli')return req.method==='GET'?json(200,accounts.cliConfiguration()):respond(405,'Method not allowed');
      if(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)){res.setHeader('Access-Control-Allow-Origin','*');return req.method==='GET'?json(200,mcpMetadata(settings)):respond(405,'Method not allowed');}
      if(url.pathname==='/api/connector-proxy')return credentialProxy?await credentialProxy(req,res):respond(503,'Connector proxy unavailable');
      if(url.pathname==='/mcp')return await mcp(req,res);
      if(url.pathname.startsWith('/api/sessions/'))return await capture(req,res);
      if(url.pathname==='/api/search')return await query(req,res);
      if(url.pathname==='/api/search/fetch')return await fetchPassage(req,res);
      if(url.pathname.startsWith('/api/board/')){if(req.headers.origin)return respond(403,'Browser request denied');return await boardHandler(req,res);}
      if(url.pathname==='/api/cli/me'){
        if(req.method!=='GET')return respond(405,'Method not allowed');
        if(req.headers.origin)return respond(403,'Browser request denied');
        const result=await identifyAgent(req);
        if(result.status!==200)return json(result.status,{schemaVersion:1,error:{code:result.status===403?(result.code||'ACCESS_DENIED'):'AUTH_REQUIRED'}});
        const workspace:{id:string;name:string|null}={id:result.principal.tenantId,name:null};
        try{const organization=await directory.organizations.getOrganization(workspace.id);if(organization.id===workspace.id)workspace.name=organization.name;}catch{/* Display failure does not invalidate a verified sign-in. */}
        if(!isWorkloadPrincipal(result.principal))await observe.cli(result.principal);return json(200,{schemaVersion:1,data:{user:result.user,workspace,index:{available:false},...('workload' in result?{credential:'workspace-identity',workload:result.workload}:{})}});
      }
      if(req.method==='GET'&&url.pathname==='/setup-prompt.txt'){res.setHeader('Access-Control-Allow-Origin','*');return respond(200,captureSetupPrompt(settings.url));}
      if(req.method==='GET'&&url.pathname==='/robots.txt')return respond(200,'User-agent: *\nDisallow: /\n');
      if(req.method==='GET'&&/^\/console\/assets\/(app|callback)\.(js|css)$/.test(url.pathname))return respond(200,await readAsset('web-v2/dist/selfhost/'+url.pathname.split('/').at(-1)),url.pathname.endsWith('.css')?'text/css':'text/javascript; charset=utf-8');
      if(req.method==='GET'&&assets.has(url.pathname)){const [file,type]=assets.get(url.pathname)!;return respond(200,await readAsset(file),type);}
      if(req.method==='GET'&&url.pathname==='/signed-out')return message(200,'You’re signed out','You have signed out of OpenCrawl.');
      if(await accounts.route(req,res,url))return;
      const oauthCallback=url.pathname==='/oauth/connectors/slack/callback'&&req.method==='GET';
      const route=oauthCallback?{name:'connector-oauth-callback'}:productRoute(req.method||'',url.pathname);
      if(!route)return respond(404,'Not found');
      if(route.status)return respond(route.status,'Method not allowed');
      if(req.method==='POST'&&req.headers.origin!==settings.url)return respond(403,'Invalid request origin');
      const browser=await accounts.browserIdentity(req,res);
      if(!browser.authenticated)return url.pathname.startsWith('/api/')?respond(401,'Sign in required'):redirect(await identity.setupRequired()?'/auth/signup':accounts.loginUrl(url.pathname+url.search));
      const current=await admit(browser);
      if(current.status!==200)return respond(current.status,current.status===503?'Sign-in is temporarily unavailable.':'Workspace access denied');
      const {principal,user,member,cacheScope}=current,activeIdentity=browser;
      if(oauthCallback)return oauth?redirect(await oauth.complete(principal,url.searchParams)):respond(404,'Connector not configured');
      const revalidate=async()=>{const next=await admit(activeIdentity);return next.status===200&&(!isAdmin(member)||isAdmin(next.member));};
      const sources=(p:Principal)=>integrations?integrations.list(p):Promise.resolve([]);
      const consoleApi=createConsoleApi({invitationPolicy:{delivery:'link',beforeAgentSetup:true},url:settings.url,setupPrompt:captureSetupPrompt(settings.url),organization:id=>directory.organizations.getOrganization(id),members,user:id=>directory.userManagement.getUser(id),
        invitations:(u,id,known)=>organizations.pendingInvitations(u,id,known),invite:(u,id,email)=>organizations.invite(u,id,email),changeRole:(u,id,target,role)=>organizations.changeRole(u,id,target,role),removeMember:(u,id,target)=>organizations.removeMember(u,id,target),renameOrganization:(u,id,name)=>organizations.rename(u,id,name),sources,
        usage:p=>usageReport({principal:p,directory,integrations,search,connectors,onboarding,values}),progress:guided.progress,next:guided.next,library,libraryFailure});
      const execute=async(request:IncomingMessage,target:URL,selected:Route,reply:typeof respond,rpc=false)=>{
        if(selected.name.startsWith('/api/console/')){
          if(selected.name!=='/api/console/bootstrap'&&!hasReceipt((await guided.progress(principal))?.completed))return reply(409,JSON.stringify({error:'Complete onboarding before opening the workspace.',onboardingUrl:await guided.next(principal)}),'application/json');
          const result=await consoleApi(request,selected.name,{principal,user,member,cacheScope,admitted:true,revalidate:rpc?async()=>true:revalidate});return reply(result.status,JSON.stringify(result.body),'application/json');
        }
        if(request.method==='GET'&&consolePages.has(target.pathname)){
          const progress=await guided.progress(principal);
          if(!target.pathname.startsWith('/onboarding')&&!hasReceipt(progress?.completed))return redirect(await guided.next(principal));
          // An admin can invite teammates while connecting their own agent. Other setup and workspace gates remain receipt-based.
          if(target.pathname.startsWith('/onboarding/')&&!(target.pathname==='/onboarding/invite'&&isAdmin(member))&&!hasReceipt(progress?.completed)&&!(progress&&deriveOnboarding(progress).complete))return redirect('/onboarding');
          return reply(200,consoleDocument(),'text/html; charset=utf-8');
        }
        if(guided.handles(selected.name))return guided.handle(request,{route:selected,principal,identity:{user},member,respond:reply});
        if(selected.name==='/api/onboarding')return reply(200,JSON.stringify({data:{...await onboarding.read(principal),displayName:user.firstName?.trim()||null}}),'application/json');
        if(['debug-search','debug-board'].includes(selected.name))return diagnosticRequest(request,target,selected,{search,connectors,board,principal,admin:isAdmin(member),revalidate:async()=>rpc||await revalidate()?200:403,respond:reply});
        if(selected.name==='integration-credential'){
          const refuse=(status:number,code:string,text:string)=>reply(status,JSON.stringify({error:{code,message:text}}),'application/json');
          if(!connectorSettings)return refuse(503,'INTEGRATIONS_NOT_CONFIGURED','Integrations aren’t available yet.');
          if(!isAdmin(member))return refuse(403,'ADMIN_REQUIRED','Only a workspace admin can change connector settings.');
          try{const {value}=await smallJson(request,8192);await connectorSettings.save(selected.provider||'',value,principal);return reply(200,JSON.stringify({ok:true}),'application/json');}
          catch(error){const info=errorInfo(error);return info.expose?refuse(info.status||400,'CREDENTIAL_NOT_SAVED',info.message):refuse(503,'INTEGRATION_UNAVAILABLE','We couldn’t save that. Please try again.');}
        }
        if(selected.name.startsWith('integration-')||selected.name.startsWith('/api/integrations'))return integrationRequest(request,target,selected,{integrations,providers,principal,member,onboarding,guided,respond:reply,message,document});
        if(selected.name==='cloud-capture'||selected.name==='cloud-capture-revoke'){
          let credential,revoked=false;
          if(request.method==='POST'){
            let size=0;const chunks:Buffer[]=[];for await(const chunk of request){size+=chunk.length;if(size>4096)return reply(413,'Request too large');chunks.push(chunk);}
            if(selected.name==='cloud-capture-revoke'){await credentials.revoke(principal,new URLSearchParams(Buffer.concat(chunks).toString()).get('id')||'');revoked=true;}else credential=await credentials.issue(principal);
          }
          return reply(200,document(cloudCapturePage({api:settings.url,credential,revoked}),{signedIn:true}),'text/html; charset=utf-8');
        }
        return reply(404,'Not found');
      };
      if(route.name==='web-rpc'){
        const result=await handleProductRpc(req,url,productRouter,{invoke:async<T,>(path:string,method:'GET'|'POST'='GET',input?:object):Promise<T>=>{
          const target=new URL(path,settings.url),selected=productRoute(method,target.pathname);
          if(!selected||selected.status||selected.name==='web-rpc')throw rpcError(400,'Unknown web operation.');
          const request=Object.assign(Readable.from(input===undefined?[]:[Buffer.from(JSON.stringify(input))]),{url:path,method,headers:{origin:settings.url}}) as IncomingMessage;
          let status=503,body='';await execute(request,target,selected,(s,b)=>{status=s;body=b.toString();},true);
          let value:unknown;try{value=JSON.parse(body);}catch{throw rpcError(status,'This information is temporarily unavailable. Try again.');}
          if(status>=400){const e=value&&typeof value==='object'&&'error' in value?value.error:null;throw rpcError(status,typeof e==='string'?e:e&&typeof e==='object'&&'message'in e&&typeof e.message==='string'?e.message:'This information is temporarily unavailable. Try again.');}return value as T;
        }},revalidate);return respond(result.status,result.body,'application/json');
      }
      return await execute(req,url,route,respond);
    }catch(error){if(res.headersSent)return res.end();return respond(errorInfo(error).status===403?403:503,'Service temporarily unavailable');}
  };
}
