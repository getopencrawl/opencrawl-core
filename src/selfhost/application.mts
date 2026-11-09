import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Workos,Principal} from '../identity/types.mjs';
import type {SelfhostSettings} from './settings.mjs';
import type {createObjectStore} from '../sessions/s3-store.mjs';
import type {Integrations} from '../integrations/service.mjs';
import type {ProviderCatalog} from '../integrations/types.mjs';
import type {createConnectorResolver} from '../integrations/resolver.mjs';
import {createWorkos} from '../identity/workos.mjs';
import {Readable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {cookies,sealFlow,openFlow,verifiedUser,currentVerifiedUser} from '../identity/auth.mjs';
import {singleOrganizationIdentity} from '../identity/single-organization.mjs';
import {singleOrganizationPrincipal} from '../identity/principal.mjs';
import {cliIdentity,cliConfiguration} from '../identity/cli.mjs';
import {mcpIdentity,mcpMetadata} from '../identity/mcp.mjs';
import {teamService,isAdmin} from '../identity/team.mjs';
import {roleWriteGuard} from '../identity/role-write.mjs';
import {createOnboardingStatus} from '../onboarding-status.mjs';
import {hasReceipt} from '../onboarding-state.mjs';
import {createOnboardingObserver} from '../application/onboarding-observer.mjs';
import {createGuidedOnboarding} from '../application/onboarding.mjs';
import {smallJson} from '../application/http.mjs';
import {createConsoleApi,consoleDocument,consolePages} from '../application/console.mjs';
import {productRoute,type Route} from '../application/routes.mjs';
import {productRouter,handleProductRpc,rpcError} from '../application/rpc.mjs';
import {usageReport} from '../application/usage.mjs';
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
import {captureSetupPrompt,renderCloudCaptureSetup} from '../sessions/cloud-setup.mjs';
import {createCaptureCredentials,isCaptureCredential} from '../sessions/credentials.mjs';
import {createSessionIngest,createCaptureHandler} from '../sessions/ingest.mjs';
import {errorInfo} from '../errors.mjs';
const SESSION='__Host-opencrawl-session',FLOW='__Host-opencrawl-flow';
type Store=ReturnType<typeof createObjectStore>;
export interface SelfhostApplicationOptions {
  settings:SelfhostSettings;store:Store;prefix:string;workos?:Workos;
  integrations?:Integrations;providers?:ProviderCatalog;connectors?:ReturnType<typeof createConnectorResolver>;
  readAsset?:(file:string)=>Promise<string|Buffer>;
}
/** Full product composition for one operator-owned WorkOS organization. */
export function selfhostApplication({settings,store,prefix,workos:sdk,integrations,providers={},connectors,
  readAsset=file=>readFile(new URL('../../../'+file,import.meta.url)),
}:SelfhostApplicationOptions) {
  const workos=sdk||createWorkos(settings);
  const admit=singleOrganizationIdentity(workos,settings.organizationId),resolve=singleOrganizationPrincipal(workos,settings.organizationId);
  const identifyCli=cliIdentity(settings,workos),organizations=teamService(workos,roleWriteGuard(store,prefix));
  const onboarding=createOnboardingStatus({store,prefix}),observe=createOnboardingObserver(onboarding);
  const search=createSessionSearch(settings.search);
  async function authorize(principal:Principal,requested?:unknown) {
    if(principal?.tenantId!==settings.organizationId || principal.captureAccess!==undefined || requested!=null&&requested!==settings.organizationId)throw Object.assign(new Error('Workspace access denied'),{status:403});
    const current=await currentVerifiedUser(workos,principal.userId);
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
  const authenticate=async(req:IncomingMessage)=>{const identity=await identifyCli(req.headers.authorization,{capture:true});if(identity.status!==200)throw Object.assign(new Error('Sign in required'),{status:identity.status});return identity.principal;};
  const query=createWorkspaceSearchHandler({search:authorizedSearch,authenticate});
  const fetchPassage=createWorkspaceSearchHandler({search:authorizedSearch,authenticate,operation:'fetch'});
  const boardHandler=createBoardHandler({board,authenticate});
  const mcp=createOpenCrawlMcp({origin:settings.url,revision:settings.revision,search:authorizedSearch,board,authenticate:mcpIdentity(settings,workos),onConnectionTest:p=>onboarding.mcpTest(p),onAuthenticated:(p,info)=>onboarding.mcp(p,info)});
  const credentials=createCaptureCredentials({store,prefix});
  const capture=createCaptureHandler({credentials,search,ingest:createSessionIngest({store,prefix,onStored:observe.session}),authenticate:async req=>{
    const token=/^Bearer (.+)$/.exec(req.headers.authorization||'')?.[1];
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
  const guided=createGuidedOnboarding({onboarding,integrations,organizations,authorizedSearch,smallJson});
  const library=createLibraryApi({sessions:createSessionLibrary({store,prefix,...settings.search}),memories:createMemoryLibrary({store,prefix,...settings.search})});
  const members=async(organizationId:string)=>{
    if(organizationId!==settings.organizationId)throw Object.assign(new Error('Workspace access denied'),{status:403});
    const result=await workos.userManagement.listOrganizationMemberships({organizationId,statuses:['active'],limit:100});
    const rows=result.autoPagination?await result.autoPagination():result.data;
    return [...new Map(rows.filter(m=>m.organizationId===organizationId&&m.status==='active').map(m=>[m.userId,m])).values()];
  };
  const assets=new Map<string,[string,string]>([
    ['/favicon.svg',['web/assets/opencrawl-mark.svg','image/svg+xml']],['/shell.css',['web/auth.css','text/css']],
    ...['tokens.css','frame.css','controls.css','cloud-capture.css'].map((f):[string,[string,string]]=>['/'+f,['web/'+f,'text/css']]),
    ...['geist-sans.woff2','geist-mono.woff2','opencrawl-mark.svg'].map((f):[string,[string,string]]=>['/assets/'+f,['web/assets/'+f,f.endsWith('.svg')?'image/svg+xml':'font/woff2']]),
    ...['googledrive','slack','granola','circleback','notion','github'].flatMap(f=>['connectors','integrations'].map((kind):[string,[string,string]]=>[`/assets/${kind}/${f}.svg`,[`web/assets/connectors/${f}.svg`,'image/svg+xml']])),
  ]);
  return async(req:IncomingMessage,res:ServerResponse)=>{
    for(const [key,value] of Object.entries(securityHeaders))res.setHeader(key,key==='Content-Security-Policy'?value.replace('https://*.authkit.app',settings.authOrigin):value);
    const respond=(status:number,body:string|Buffer,type='text/plain; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type});res.end(body);};
    const json=(status:number,body:unknown)=>respond(status,JSON.stringify(body),'application/json');
    const redirect=(location:string)=>{res.writeHead(303,{Location:location});res.end();};
    const message=(status:number,heading:string,detail:string,href='/auth/login',action='Sign in')=>respond(status,document(`<main><h1>${heading}</h1><p>${detail}</p><a class="button-link primary" href="${href}">${action}</a></main>`),'text/html; charset=utf-8');
    const cookie=(name:string,value:string,age=604800)=>{const old=res.getHeader('Set-Cookie');res.setHeader('Set-Cookie',[...(Array.isArray(old)?old:old?[String(old)]:[]),`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`]);};
    try {
      const url=new URL(req.url||'/',settings.url);
      if(req.method==='GET'&&url.pathname==='/health')return json(200,{ok:true,mode:'selfhost',revision:settings.revision||'development'});
      if(url.pathname==='/.well-known/opencrawl-cli')return req.method==='GET'?json(200,cliConfiguration(settings)):respond(405,'Method not allowed');
      if(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)){res.setHeader('Access-Control-Allow-Origin','*');return req.method==='GET'?json(200,mcpMetadata(settings)):respond(405,'Method not allowed');}
      if(url.pathname==='/mcp')return await mcp(req,res);
      if(url.pathname.startsWith('/api/sessions/'))return await capture(req,res);
      if(url.pathname==='/api/search')return await query(req,res);
      if(url.pathname==='/api/search/fetch')return await fetchPassage(req,res);
      if(url.pathname.startsWith('/api/board/')){if(req.headers.origin)return respond(403,'Browser request denied');return await boardHandler(req,res);}
      if(url.pathname==='/api/cli/me'){
        if(req.method!=='GET')return respond(405,'Method not allowed');
        if(req.headers.origin)return respond(403,'Browser request denied');
        const result=await identifyCli(req.headers.authorization,{capture:true});
        if(result.status!==200)return json(result.status,{schemaVersion:1,error:{code:'AUTH_REQUIRED'}});
        await observe.cli(result.principal);return json(200,{schemaVersion:1,data:{user:result.user,index:{available:false}}});
      }
      if(req.method==='GET'&&url.pathname==='/setup-prompt.txt'){res.setHeader('Access-Control-Allow-Origin','*');return respond(200,captureSetupPrompt(settings.url));}
      if(req.method==='GET'&&url.pathname==='/robots.txt')return respond(200,'User-agent: *\nDisallow: /\n');
      if(req.method==='GET'&&/^\/console\/assets\/(app\.(js|css)|callback.js)$/.test(url.pathname))return respond(200,await readAsset('web-v2/dist/selfhost/'+url.pathname.split('/').at(-1)),url.pathname.endsWith('.css')?'text/css':'text/javascript; charset=utf-8');
      if(req.method==='GET'&&assets.has(url.pathname)){const [file,type]=assets.get(url.pathname)!;return respond(200,await readAsset(file),type);}
      if(req.method==='GET'&&url.pathname==='/signed-out')return message(200,'You’re signed out','You have signed out of OpenCrawl.');
      const jar=cookies(req.headers.cookie);
      if(req.method==='GET'&&['/auth/login','/auth/signup'].includes(url.pathname)) {
        const flow=await workos.userManagement.getAuthorizationUrlWithPKCE({provider:'authkit',clientId:settings.clientId,organizationId:settings.organizationId,redirectUri:settings.url+'/auth/callback',screenHint:url.pathname==='/auth/signup'?'sign-up':'sign-in',...(url.searchParams.get('invitation_token')?{invitationToken:url.searchParams.get('invitation_token')!}:{})});
        cookie(FLOW,sealFlow({state:flow.state,codeVerifier:flow.codeVerifier,expiresAt:Date.now()+600000},settings.cookiePassword),600);return redirect(flow.url);
      }
      if(req.method==='GET'&&url.pathname==='/auth/callback') {
        cookie(FLOW,'',0);
        const flow=openFlow(jar[FLOW]||'',url.searchParams.get('state')||'',settings.cookiePassword);
        if(!flow||!url.searchParams.get('code')||url.searchParams.has('error'))return message(400,'Try signing in again','This sign-in link expired or could not be verified.');
        const result=await workos.userManagement.authenticateWithCode({clientId:settings.clientId,code:url.searchParams.get('code')!,codeVerifier:flow.codeVerifier,session:{sealSession:true,cookiePassword:settings.cookiePassword}});
        if(!verifiedUser(result.user)||result.organizationId!=null&&result.organizationId!==settings.organizationId||!await resolve(result.user,result.organizationId))return message(403,'Workspace access denied','Ask an organization admin for an invitation.');
        if(!result.sealedSession)return message(503,'Sign-in is unavailable','Try signing in again.');
        cookie(SESSION,result.sealedSession);return redirect('/');
      }
      const route=productRoute(req.method||'',url.pathname);
      if(!route)return respond(404,'Not found');
      if(route.status)return respond(route.status,'Method not allowed');
      if(req.method==='POST'&&req.headers.origin!==settings.url)return respond(403,'Invalid request origin');
      let identity,session;
      if(jar[SESSION]) {
        session=workos.userManagement.loadSealedSession({sessionData:jar[SESSION],cookiePassword:settings.cookiePassword});identity=await session.authenticate();
        if(!identity.authenticated){const refreshed=await session.refresh();if(refreshed.authenticated&&refreshed.sealedSession){cookie(SESSION,refreshed.sealedSession);identity=await session.authenticate();}else if('retryable' in refreshed&&refreshed.retryable)return respond(503,'Sign-in is temporarily unavailable.');}
      }
      if(!identity?.authenticated){cookie(SESSION,'',0);return url.pathname==='/auth/logout'?redirect('/signed-out'):url.pathname.startsWith('/api/')?respond(401,'Sign in required'):redirect('/auth/login');}
      if(url.pathname==='/auth/logout'){cookie(SESSION,'',0);return redirect(await session!.getLogoutUrl({returnTo:settings.url+'/signed-out'}));}
      const current=await admit(identity);
      if(current.status!==200)return respond(current.status,current.status===503?'Sign-in is temporarily unavailable.':'Workspace access denied');
      const {principal,user,member,cacheScope}=current,activeIdentity=identity;
      const revalidate=async()=>{const next=await admit(activeIdentity);return next.status===200&&(!isAdmin(member)||isAdmin(next.member));};
      const sources=(p:Principal)=>integrations?integrations.list(p):Promise.resolve([]);
      const consoleApi=createConsoleApi({url:settings.url,setupPrompt:captureSetupPrompt(settings.url),organization:id=>workos.organizations.getOrganization(id),members,user:id=>workos.userManagement.getUser(id),
        invitations:(u,id,known)=>organizations.pendingInvitations(u,id,known),invite:(u,id,email)=>organizations.invite(u,id,email),changeRole:(u,id,target,role)=>organizations.changeRole(u,id,target,role),renameOrganization:(u,id,name)=>organizations.rename(u,id,name),sources,
        usage:p=>usageReport({principal:p,workos,integrations,search,connectors,onboarding}),progress:guided.progress,next:guided.next,library,libraryFailure});
      const execute=async(request:IncomingMessage,target:URL,selected:Route,reply:typeof respond,rpc=false)=>{
        if(selected.name.startsWith('/api/console/')){
          if(selected.name!=='/api/console/bootstrap'&&!hasReceipt((await guided.progress(principal))?.completed))return reply(409,JSON.stringify({error:'Complete onboarding before opening the workspace.',onboardingUrl:await guided.next(principal)}),'application/json');
          const result=await consoleApi(request,selected.name,{principal,user,member,cacheScope,admitted:true,revalidate:rpc?async()=>true:revalidate});return reply(result.status,JSON.stringify(result.body),'application/json');
        }
        if(request.method==='GET'&&consolePages.has(target.pathname)){
          const progress=await guided.progress(principal);
          if(!target.pathname.startsWith('/onboarding')&&!hasReceipt(progress?.completed))return redirect(await guided.next(principal));
          if(target.pathname.startsWith('/onboarding/')&&!hasReceipt(progress?.completed)){const next=await guided.next(principal);if(next==='/onboarding'||target.pathname==='/onboarding/invite'&&next==='/onboarding/sources')return redirect(next);}
          return reply(200,consoleDocument(),'text/html; charset=utf-8');
        }
        if(guided.handles(selected.name))return guided.handle(request,{route:selected,principal,identity:{user},member,respond:reply});
        if(selected.name==='/api/onboarding')return reply(200,JSON.stringify({data:{...await onboarding.read(principal),displayName:user.firstName?.trim()||null}}),'application/json');
        if(['debug-search','debug-board'].includes(selected.name))return diagnosticRequest(request,target,selected,{search,connectors,board,principal,admin:isAdmin(member),revalidate:async()=>rpc||await revalidate()?200:403,respond:reply});
        if(selected.name.startsWith('integration-')||selected.name.startsWith('/api/integrations'))return integrationRequest(request,target,selected,{integrations,providers,principal,onboarding,guided,respond:reply,message,document});
        if(selected.name==='cloud-capture'||selected.name==='cloud-capture-revoke'){
          let credential,revoked=false;
          if(request.method==='POST'){
            let size=0;const chunks:Buffer[]=[];for await(const chunk of request){size+=chunk.length;if(size>4096)return reply(413,'Request too large');chunks.push(chunk);}
            if(selected.name==='cloud-capture-revoke'){await credentials.revoke(principal,new URLSearchParams(Buffer.concat(chunks).toString()).get('id')||'');revoked=true;}else credential=await credentials.issue(principal);
          }
          return reply(200,document(renderCloudCaptureSetup({api:settings.url,credential,revoked}),{signedIn:true,cloudCapture:true,title:'Claude cloud capture | OpenCrawl'}),'text/html; charset=utf-8');
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
