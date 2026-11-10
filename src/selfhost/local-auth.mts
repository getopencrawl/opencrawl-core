import type {IncomingMessage,ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {toNodeHandler,fromNodeHeaders} from 'better-auth/node';
import {oauthProviderAuthServerMetadata,oauthProviderOpenIdConfigMetadata} from '@better-auth/oauth-provider';
import {jwtVerify} from 'jose';
import {document} from '../application/presentation.mjs';
import {errorInfo} from '../errors.mjs';
import {CLI_CLIENT_ID,type LocalIdentity} from '../identity/better-auth.mjs';
import {currentVerifiedUser,type BrowserIdentity} from '../identity/auth.mjs';
import {singleOrganizationPrincipal} from '../identity/principal.mjs';
import type {Principal} from '../identity/types.mjs';

type CliResult={status:200;user:{id:string;email:string};principal:Principal}|{status:401|403|503;code?:string};
// Browsers reach only the protocol endpoints; account, organization and admin
// operations run server-side behind this application's own authorization.
const PUBLIC=new Map<string,string>([['/api/auth/oauth2/authorize','GET'],['/api/auth/oauth2/token','POST'],['/api/auth/oauth2/register','POST'],
  ['/api/auth/oauth2/revoke','POST'],['/api/auth/oauth2/introspect','POST'],['/api/auth/oauth2/userinfo','GET'],['/api/auth/jwks','GET']]);
const message=(heading:string,detail:string,signedIn=false)=>document({kind:'message',heading,detail,href:'/auth/login',action:'Sign in'},{signedIn});

async function readForm(req:IncomingMessage){
  if(req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded')throw Object.assign(new Error('Expected a form'),{status:415});
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of req){size+=chunk.length;if(size>16384)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(Buffer.from(chunk));}
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
const sameToken=(a:string,b:string)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));

export interface LocalAuthOptions {
  identity:LocalIdentity;url:string;organizationId:string;setupToken:string;
  /** Current membership of a browser identity; consent and device approval require it. */
  member(identity:BrowserIdentity):Promise<boolean>;
}
/** Sign-in, first-run setup, invitations, MCP consent and CLI device approval for self-host. */
export function localAuth({identity,url,organizationId,setupToken,member}:LocalAuthOptions){
  if(!setupToken)throw new Error('A private setup token is required');
  const {auth,directory}=identity,handler=toNodeHandler(auth);
  const authorizationMetadata=oauthProviderAuthServerMetadata(auth),openidMetadata=oauthProviderOpenIdConfigMetadata(auth);
  const resolve=singleOrganizationPrincipal(directory,organizationId);
  const forwardCookies=(res:ServerResponse,headers:Headers|null|undefined)=>{
    const cookies=headers?.getSetCookie?.()||[];if(!cookies.length)return;
    const old=res.getHeader('Set-Cookie');res.setHeader('Set-Cookie',[...(Array.isArray(old)?old:old?[String(old)]:[]),...cookies]);
  };
  const html=(res:ServerResponse,status:number,body:string)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8'});res.end(body);};
  // CSP form-action also governs redirects after a form post, so leave this
  // origin by navigation rather than a redirect (OAuth client callbacks).
  const go=(res:ServerResponse,location:string)=>{
    if(new URL(location,url).origin===url){res.writeHead(303,{Location:location});return void res.end();}
    const destination=new URL(location);
    if(!['http:','https:'].includes(destination.protocol))throw Object.assign(new Error('Invalid OAuth callback'),{status:400});
    html(res,200,document({kind:'oauth-return',url:destination.href}));
  };
  const json=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  async function fetchAuth(path:string,init:RequestInit){return auth.handler(new Request(url+'/api/auth'+path,init));}
  const authHeaders=(req:IncomingMessage)=>new Headers({cookie:req.headers.cookie||'',origin:req.headers.origin||url,'user-agent':req.headers['user-agent']||'',
    'x-opencrawl-client-ip':req.socket.remoteAddress||'unknown',accept:'application/json','content-type':'application/json'});
  const accountRequest=(req:IncomingMessage,path:string,body:Record<string,unknown>)=>fetchAuth(path,{method:'POST',headers:authHeaders(req),body:JSON.stringify(body)});
  async function relay(res:ServerResponse,response:Response){
    res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json','Cache-Control':'no-store'});res.end(Buffer.from(await response.arrayBuffer()));
  }

  async function browserIdentity(req:IncomingMessage,res?:ServerResponse):Promise<BrowserIdentity>{
    const result=await auth.api.getSession({headers:fromNodeHeaders(req.headers),returnHeaders:true});
    if(res)forwardCookies(res,result.headers);
    const session=result.response;
    if(!session)return {authenticated:false};
    return {authenticated:true,sessionId:session.session.id,user:{id:session.user.id,email:session.user.email,emailVerified:session.user.emailVerified}};
  }

  // Signed-in pages send people back here after sign-in.
  const loginUrl=(next:string)=>'/auth/login?next='+encodeURIComponent(next);
  const safeNext=(value:string|null)=>value&&value.startsWith('/')&&!value.startsWith('//')&&!value.includes('\\')&&new URL(value,url).origin===url?value:'/';

  function loginPage(params:URLSearchParams,error?:string){
    const oauthQuery=params.has('client_id')&&params.has('sig')?params.toString():params.get('oauth_query')||undefined;
    return document({kind:'auth',view:'login',error,oauthQuery,next:safeNext(params.get('next')),invitation:params.get('invitation')||undefined});
  }
  async function signupPage(params:URLSearchParams,error?:string){
    const invitationId=params.get('invitation');
    if(invitationId){
      const invitation=await identity.pendingInvitation(invitationId);
      if(!invitation)return message('This invitation is no longer valid','Ask an admin for a new invitation link.');
      return document({kind:'auth',view:'join',error,email:invitation.email,invitation:invitationId});
    }
    if(!await identity.setupRequired())return message('Ask for an invitation','This workspace is already set up. An admin can invite you from the Team page.');
    if(!sameToken(params.get('setup')||'',setupToken))return message('Open the setup link','Use the private setup link printed by the installer to create the first admin account.');
    return document({kind:'auth',view:'setup',error,setup:params.get('setup')});
  }
  /** Signs in through Better Auth so an OAuth authorization in progress continues. */
  async function signIn(req:IncomingMessage,res:ServerResponse,email:string,password:string,oauthQuery?:string|null){
    const response=await accountRequest(req,'/sign-in/email',{email,password,...(oauthQuery?{oauth_query:oauthQuery}:{})});
    if(response.status===429)throw Object.assign(new Error('Too many sign-in attempts. Try again shortly.'),{status:429});
    if(!response.ok)return null;
    forwardCookies(res,response.headers);
    const body=await response.json().catch(()=>({})) as {url?:string;redirect?:boolean;user?:{id:string}};
    return body;
  }

  async function login(req:IncomingMessage,res:ServerResponse,target:URL){
    if(req.method==='GET')return html(res,200,loginPage(target.searchParams));
    const form=await readForm(req),email=(form.get('email')||'').trim().toLowerCase(),password=form.get('password')||'';
    const result=await signIn(req,res,email,password,form.get('oauth_query'));
    if(!result)return html(res,401,loginPage(form,'That email and password don’t match an account here.'));
    const invitationId=form.get('invitation');
    if(invitationId&&result.user){
      const invitation=await identity.pendingInvitation(invitationId);
      if(invitation&&invitation.email===email)await identity.admitAccount(result.user.id,invitation.role==='admin'?'admin':'member',invitation.id);
    }
    return go(res,result.url||safeNext(form.get('next')));
  }
  async function signup(req:IncomingMessage,res:ServerResponse,target:URL){
    if(req.method==='GET')return html(res,200,await signupPage(target.searchParams));
    const form=await readForm(req),password=form.get('password')||'',name=(form.get('name')||'').trim().slice(0,100);
    if(password.length<10||!name)return html(res,400,await signupPage(form,'Enter your name and a password of at least 10 characters.'));
    const invitationId=form.get('invitation');
    let email:string,role:'admin'|'member',workspace:string|undefined;
    if(invitationId){
      const invitation=await identity.pendingInvitation(invitationId);
      if(!invitation)return html(res,410,await signupPage(form));
      email=invitation.email;role=invitation.role==='admin'?'admin':'member';
    }else{
      if(!await identity.setupRequired()||!sameToken(form.get('setup')||'',setupToken))return html(res,403,await signupPage(form));
      email=(form.get('email')||'').trim().toLowerCase();role='admin';
      workspace=(form.get('workspace')||'').trim();
      if(!workspace||workspace.length>100||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return html(res,400,await signupPage(form,'Enter a workspace name and a valid email address.'));
    }
    let created:{user:{id:string}};
    try{
      const response=await accountRequest(req,'/sign-up/email',{email,password,name});
      if(!response.ok)throw Object.assign(new Error('Account creation failed'),{status:response.status});
      created=await response.json() as {user:{id:string}};
    }
    catch(error){return html(res,errorInfo(error).status===429?429:errorInfo(error).status===422||errorInfo(error).status===400?409:503,await signupPage(form,'An account with this email already exists. Sign in instead.'));}
    // A second first-run submission loses here rather than becoming another admin.
    if(!invitationId&&!await identity.setupRequired())return html(res,403,await signupPage(form));
    await identity.admitAccount(created.user.id,role,invitationId||undefined,workspace);
    const result=await signIn(req,res,email,password);
    return go(res,result?'/':'/auth/login');
  }

  async function signedInMember(req:IncomingMessage,res:ServerResponse,target:URL){
    const browser=await browserIdentity(req,res);
    if(!browser.authenticated){go(res,loginUrl(target.pathname+target.search));return null;}
    if(!await member(browser)){html(res,403,message('Workspace access denied','Ask an organization admin for an invitation.',true));return null;}
    return browser;
  }
  async function consent(req:IncomingMessage,res:ServerResponse,target:URL){
    const query=req.method==='GET'?target.searchParams.toString():null;
    if(!await signedInMember(req,res,target))return;
    if(req.method==='GET'){
      const client=await auth.api.getOAuthClientPublic({query:{client_id:target.searchParams.get('client_id')||''},headers:fromNodeHeaders(req.headers)}).catch(()=>null) as {client_name?:string}|null;
      return html(res,200,document({kind:'auth',view:'consent',clientName:client?.client_name||'this app',oauthQuery:query,resource:identity.resource,scopes:(target.searchParams.get('scope')||'').split(' ').filter(Boolean)},{signedIn:true}));
    }
    const form=await readForm(req);
    const response=await auth.api.oauth2Consent({body:{accept:form.get('accept')==='true',oauth_query:form.get('oauth_query')||''},headers:new Headers({...Object.fromEntries(fromNodeHeaders(req.headers)),accept:'application/json'}),asResponse:true});
    const body=await response.json().catch(()=>({})) as {url?:string;redirect_uri?:string};
    const location=body.url||body.redirect_uri;
    return location?go(res,location):html(res,400,message('This request expired','Start connecting your app again.',true));
  }
  async function device(req:IncomingMessage,res:ServerResponse,target:URL){
    if(!await signedInMember(req,res,target))return;
    const headers=fromNodeHeaders(req.headers);
    if(req.method==='GET'){
      const code=(target.searchParams.get('user_code')||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,16);
      return html(res,200,document({kind:'auth',view:'device',code},{signedIn:true}));
    }
    const form=await readForm(req),userCode=(form.get('user_code')||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    try{
      await auth.api.deviceVerify({query:{user_code:userCode},headers});
      if(form.get('decision')==='approve')await auth.api.deviceApprove({body:{userCode},headers});else await auth.api.deviceDeny({body:{userCode},headers});
    }catch{return html(res,400,message('That code didn’t work','Run opencrawl login again for a new code.',true));}
    return html(res,200,message(form.get('decision')==='approve'?'CLI connected':'Sign-in cancelled','Return to your terminal.',true));
  }
  /** The portable CLI speaks plain RFC 8628; tokens are bound to this deployment's MCP resource. */
  async function cliToken(req:IncomingMessage,res:ServerResponse,path:'/device/code'|'/oauth2/token'){
    if(req.method!=='POST')return json(res,405,{error:'invalid_request'});
    if(req.headers.origin)return json(res,403,{error:'access_denied'});
    const form=await readForm(req);
    if(form.get('client_id')!==CLI_CLIENT_ID)return json(res,400,{error:'invalid_client'});
    form.set('resource',identity.resource);
    if(path==='/device/code'&&!form.has('scope'))form.set('scope','openid profile email offline_access');
    return relay(res,await fetchAuth(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-opencrawl-client-ip':req.socket.remoteAddress||'unknown'},body:form}));
  }

  /** Bearer tokens from the CLI device grant or an MCP client authorization. */
  async function identifyToken(authorization:string|undefined,_options?:{capture?:boolean}):Promise<CliResult>{
    const token=/^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization||'')?.[1];
    if(!token||token.length>16384)return {status:401};
    let payload;
    try{({payload}=await jwtVerify(token,identity.keyResolver,{issuer:identity.issuer,audience:identity.resource,algorithms:['RS256'],requiredClaims:['sub','exp','iat','client_id','scope'],typ:'at+jwt',clockTolerance:5}));}
    // Keys are local: a token error is invalid credentials; anything else is a storage outage.
    catch(error){return {status:errorInfo(error).code?.startsWith('ERR_J')?401:503};}
    if(typeof payload.sub!=='string'||!/^user_[A-Za-z0-9]+$/.test(payload.sub))return {status:401};
    if(typeof payload.client_id!=='string'||typeof payload.scope!=='string'||!payload.scope.split(' ').includes('openid')||payload.cnf!==undefined)return {status:401};
    if(typeof payload.iat!=='number'||!identity.tokenCurrent(payload.sub,payload.iat))return {status:401};
    const current=await currentVerifiedUser(directory,payload.sub);
    if(current.status!==200)return current;
    const principal=await resolve(current.user).catch(()=>undefined);
    if(principal===undefined)return {status:503};
    if(!principal)return {status:403,code:'ORGANIZATION_REQUIRED'};
    const {user}=current;
    return {status:200,user:{id:user.id,email:user.email},principal:{...principal,email:user.email,name:[user.firstName,user.lastName].filter(Boolean).join(' ')||null}};
  }

  /** Handles an auth route and returns true, or false for other paths. */
  async function routeAuth(req:IncomingMessage,res:ServerResponse,target:URL):Promise<boolean>{
    const path=target.pathname;
    if(path.startsWith('/api/auth/')){
      if(PUBLIC.get(path)!==req.method){json(res,404,{error:'not_found'});return true;}
      req.headers['x-opencrawl-client-ip']=req.socket.remoteAddress||'unknown';
      await handler(req,res);return true;
    }
    if(['/.well-known/oauth-authorization-server','/.well-known/oauth-authorization-server/api/auth','/.well-known/openid-configuration','/.well-known/openid-configuration/api/auth','/api/auth/.well-known/openid-configuration'].includes(path)){
      res.setHeader('Access-Control-Allow-Origin','*');
      await relay(res,await (path.includes('openid')?openidMetadata:authorizationMetadata)(new Request(url+path)));return true;
    }
    if(path==='/api/cli/device'){await cliToken(req,res,'/device/code');return true;}
    if(path==='/api/cli/token'){await cliToken(req,res,'/oauth2/token');return true;}
    const forms=req.method==='GET'||req.method==='POST';
    if(forms&&req.method==='POST'&&req.headers.origin!==url){json(res,403,{error:'Invalid request origin'});return true;}
    if(forms&&path==='/auth/login'){await login(req,res,target);return true;}
    if(forms&&path==='/auth/signup'){await signup(req,res,target);return true;}
    if(forms&&path==='/auth/consent'){await consent(req,res,target);return true;}
    if(forms&&path==='/device'){await device(req,res,target);return true;}
    if(req.method==='POST'&&path==='/auth/logout'){
      const response=await auth.api.signOut({headers:fromNodeHeaders(req.headers),asResponse:true});
      if(!response.ok){await relay(res,response);return true;}
      forwardCookies(res,response.headers);go(res,'/signed-out');return true;
    }
    return false;
  }
  async function route(req:IncomingMessage,res:ServerResponse,target:URL):Promise<boolean>{
    try{return await routeAuth(req,res,target);}catch(error){
      const code=errorInfo(error).status,status=code&&[400,403,404,409,410,413,415,429].includes(code)?code:503;
      if(status===429)res.setHeader('Retry-After','10');
      html(res,status,message(status===429?'Try again shortly':'Sign-in could not be completed',status===429?'Too many attempts. Wait a moment before trying again.':'Return to sign-in and try again. If the problem continues, contact your workspace operator.'));
      return true;
    }
  }
  const cliConfiguration=()=>({schemaVersion:1,auth:{clientId:CLI_CLIENT_ID,deviceAuthorizationEndpoint:url+'/api/cli/device',tokenEndpoint:url+'/api/cli/token'},index:{available:false}});
  const mcpIdentity=async(req:IncomingMessage,res:ServerResponse)=>{
    const result=await identifyToken(req.headers.authorization);
    if(result.status===200)return result.principal;
    if(result.status!==503)res.setHeader('WWW-Authenticate',`Bearer resource_metadata="${url}/.well-known/oauth-protected-resource/mcp", error="${result.status===401?'invalid_token':'insufficient_scope'}"`);
    json(res,result.status,{error:result.status===503?'authorization_unavailable':'authorization_required'});return null;
  };
  return {route,browserIdentity,identifyToken,mcpIdentity,cliConfiguration,loginUrl};
}
