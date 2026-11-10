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
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const hidden=(name:string,value:unknown)=>value?`<input type="hidden" name="${name}" value="${escape(value)}">`:'';
const field=(label:string,name:string,type='text',extra='')=>`<label>${label}<input class="text-input" name="${name}" type="${type}" required ${extra}></label>`;
const notice=(error?:string)=>error?`<p class="org-notice error" role="alert">${escape(error)}</p>`:'';
const page=(title:string,body:string,signedIn=false)=>document(`<main class="org-setup">${body}</main>`,{title:title+' | OpenCrawl',signedIn});

async function readForm(req:IncomingMessage){
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of req){size+=chunk.length;if(size>16384)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(Buffer.from(chunk));}
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
const sameToken=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));

export interface LocalAuthOptions {
  identity:LocalIdentity;url:string;organizationId:string;setupToken?:string;
  /** Current membership of a browser identity; consent and device approval require it. */
  member(identity:BrowserIdentity):Promise<boolean>;
}
/** Sign-in, first-run setup, invitations, MCP consent and CLI device approval for self-host. */
export function localAuth({identity,url,organizationId,setupToken,member}:LocalAuthOptions){
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
    html(res,200,page('Continue',`<h1>Returning to your app</h1><p><a class="button-link primary" href="${escape(location)}">Continue</a></p>`).replace('<head>',`<head><meta http-equiv="refresh" content="0;url=${escape(location)}">`));
  };
  const json=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  async function fetchAuth(path:string,init:RequestInit){return auth.handler(new Request(url+'/api/auth'+path,init));}
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
  const safeNext=(value:string|null)=>value&&value.startsWith('/')&&!value.startsWith('//')?value:'/';

  function loginPage(params:URLSearchParams,error?:string){
    const oauth=params.has('client_id')&&params.has('sig')?params.toString():params.get('oauth_query');
    return page('Sign in',`<h1>Sign in to OpenCrawl</h1>${notice(error)}<form class="org-form" method="post" action="/auth/login">
      ${field('Email','email','email','autocomplete="username"')}${field('Password','password','password','autocomplete="current-password"')}
      ${hidden('oauth_query',oauth)}${hidden('next',params.get('next'))}${hidden('invitation',params.get('invitation'))}<button class="primary">Sign in</button></form>
      <p class="org-note">New here? Ask an admin for an invitation link.</p>`);
  }
  async function signupPage(params:URLSearchParams,error?:string){
    const invitationId=params.get('invitation');
    if(invitationId){
      const invitation=await identity.pendingInvitation(invitationId);
      if(!invitation)return page('Invitation unavailable','<h1>This invitation is no longer valid</h1><p>Ask an admin for a new invitation link.</p>');
      return page('Join OpenCrawl',`<h1>Join your team on OpenCrawl</h1><p>Create the account for <strong>${escape(invitation.email)}</strong>.</p>${notice(error)}<form class="org-form" method="post" action="/auth/signup">
        ${field('Your name','name','text','autocomplete="name"')}${field('Password (10+ characters)','password','password','minlength="10" autocomplete="new-password"')}
        ${hidden('invitation',invitationId)}<button class="primary">Create account</button></form>
        <p class="org-note">Already have an account? <a href="/auth/login?invitation=${encodeURIComponent(invitationId)}">Sign in</a>.</p>`);
    }
    if(!await identity.setupRequired())return page('Sign up',`<h1>Ask for an invitation</h1><p>This OpenCrawl workspace is already set up. An admin can invite you from the Team page.</p><a class="button-link primary" href="/auth/login">Sign in</a>`);
    if(setupToken&&!sameToken(params.get('setup')||'',setupToken))return page('Finish setup','<h1>Open the setup link</h1><p>Use the setup link printed by the installer to create the first admin account.</p>');
    return page('Set up OpenCrawl',`<h1>Set up OpenCrawl</h1><p>Create the first admin account for this workspace.</p>${notice(error)}<form class="org-form" method="post" action="/auth/signup">
      ${field('Workspace name','workspace','text','maxlength="100" value="'+escape(params.get('workspace')||'')+'"')}${field('Your name','name','text','autocomplete="name"')}
      ${field('Email','email','email','autocomplete="username"')}${field('Password (10+ characters)','password','password','minlength="10" autocomplete="new-password"')}
      ${hidden('setup',params.get('setup'))}<button class="primary">Create workspace</button></form>`);
  }
  /** Signs in through Better Auth so an OAuth authorization in progress continues. */
  async function signIn(req:IncomingMessage,res:ServerResponse,email:string,password:string,oauthQuery?:string|null){
    const response=await auth.api.signInEmail({body:{email,password,...(oauthQuery?{oauth_query:oauthQuery}:{})},headers:new Headers({...Object.fromEntries(fromNodeHeaders(req.headers)),accept:'application/json'}),asResponse:true});
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
    let email:string,role:'admin'|'member';
    if(invitationId){
      const invitation=await identity.pendingInvitation(invitationId);
      if(!invitation)return html(res,410,await signupPage(form));
      email=invitation.email;role=invitation.role==='admin'?'admin':'member';
    }else{
      if(!await identity.setupRequired()||setupToken&&!sameToken(form.get('setup')||'',setupToken))return html(res,403,await signupPage(form));
      email=(form.get('email')||'').trim().toLowerCase();role='admin';
      const workspace=(form.get('workspace')||'').trim();
      if(!workspace||workspace.length>100||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return html(res,400,await signupPage(form,'Enter a workspace name and a valid email address.'));
      await identity.renameOrganization(workspace);
    }
    let created:{user:{id:string}};
    try{created=await auth.api.signUpEmail({body:{email,password,name}});}
    catch(error){return html(res,errorInfo(error).status===422||errorInfo(error).status===400?409:503,await signupPage(form,'An account with this email already exists. Sign in instead.'));}
    // A second first-run submission loses here rather than becoming another admin.
    if(!invitationId&&!await identity.setupRequired())return html(res,403,await signupPage(form));
    await identity.admitAccount(created.user.id,role,invitationId||undefined);
    const result=await signIn(req,res,email,password);
    return go(res,result?'/':'/auth/login');
  }

  async function signedInMember(req:IncomingMessage,res:ServerResponse,target:URL){
    const browser=await browserIdentity(req,res);
    if(!browser.authenticated){go(res,loginUrl(target.pathname+target.search));return null;}
    if(!await member(browser)){html(res,403,page('Access denied','<h1>Workspace access denied</h1><p>Ask an organization admin for an invitation.</p>',true));return null;}
    return browser;
  }
  async function consent(req:IncomingMessage,res:ServerResponse,target:URL){
    const query=req.method==='GET'?target.searchParams.toString():null;
    if(!await signedInMember(req,res,target))return;
    if(req.method==='GET'){
      const client=await auth.api.getOAuthClientPublic({query:{client_id:target.searchParams.get('client_id')||''},headers:fromNodeHeaders(req.headers)}).catch(()=>null) as {client_name?:string}|null;
      return html(res,200,page('Allow access',`<h1>Allow ${escape(client?.client_name||'this app')} to use OpenCrawl?</h1>
        <p>It will be able to search this workspace and use the agent board as you.</p><form class="org-form" method="post" action="/auth/consent">${hidden('oauth_query',query)}
        <div class="org-actions"><button class="primary" name="accept" value="true">Allow</button><button name="accept" value="false">Deny</button></div></form>`,true));
    }
    const form=await readForm(req);
    const response=await auth.api.oauth2Consent({body:{accept:form.get('accept')==='true',oauth_query:form.get('oauth_query')||''},headers:new Headers({...Object.fromEntries(fromNodeHeaders(req.headers)),accept:'application/json'}),asResponse:true});
    const body=await response.json().catch(()=>({})) as {url?:string;redirect_uri?:string};
    const location=body.url||body.redirect_uri;
    return location?go(res,location):html(res,400,page('Try again','<h1>This request expired</h1><p>Start connecting your app again.</p>',true));
  }
  async function device(req:IncomingMessage,res:ServerResponse,target:URL){
    if(!await signedInMember(req,res,target))return;
    const headers=fromNodeHeaders(req.headers);
    if(req.method==='GET'){
      const code=(target.searchParams.get('user_code')||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,16);
      return html(res,200,page('Connect the CLI',`<h1>Connect the OpenCrawl CLI</h1><p>Confirm this code matches the one in your terminal.</p><form class="org-form" method="post" action="/device">
        <label>Code<input class="text-input code-input" name="user_code" required value="${escape(code)}" autocomplete="off"></label>
        <div class="org-actions"><button class="primary" name="decision" value="approve">Connect</button><button name="decision" value="deny">Cancel</button></div></form>`,true));
    }
    const form=await readForm(req),userCode=(form.get('user_code')||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    try{
      await auth.api.deviceVerify({query:{user_code:userCode},headers});
      if(form.get('decision')==='approve')await auth.api.deviceApprove({body:{userCode},headers});else await auth.api.deviceDeny({body:{userCode},headers});
    }catch{return html(res,400,page('Code not recognized','<h1>That code didn’t work</h1><p>Run <code>opencrawl login</code> again for a new code.</p>',true));}
    return html(res,200,page('Done',form.get('decision')==='approve'?'<h1>CLI connected</h1><p>Return to your terminal.</p>':'<h1>Sign-in cancelled</h1>',true));
  }
  /** The portable CLI speaks plain RFC 8628; tokens are bound to this deployment's MCP resource. */
  async function cliToken(req:IncomingMessage,res:ServerResponse,path:'/device/code'|'/oauth2/token'){
    if(req.method!=='POST')return json(res,405,{error:'invalid_request'});
    if(req.headers.origin)return json(res,403,{error:'access_denied'});
    const form=await readForm(req);
    if(form.get('client_id')!==CLI_CLIENT_ID)return json(res,400,{error:'invalid_client'});
    form.set('resource',identity.resource);
    if(path==='/device/code'&&!form.has('scope'))form.set('scope','openid profile email offline_access');
    return relay(res,await fetchAuth(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form}));
  }

  /** Bearer tokens from the CLI device grant or an MCP client authorization. */
  async function identifyToken(authorization:string|undefined,_options?:{capture?:boolean}):Promise<CliResult>{
    const token=/^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization||'')?.[1];
    if(!token||token.length>16384)return {status:401};
    let payload;
    try{({payload}=await jwtVerify(token,identity.keyResolver,{issuer:identity.issuer,audience:identity.resource,algorithms:['RS256'],requiredClaims:['sub','exp','iat'],clockTolerance:5}));}
    // Keys are local: a token error is invalid credentials; anything else is a storage outage.
    catch(error){return {status:errorInfo(error).code?.startsWith('ERR_J')?401:503};}
    if(typeof payload.sub!=='string'||!/^user_[A-Za-z0-9]+$/.test(payload.sub))return {status:401};
    const current=await currentVerifiedUser(directory,payload.sub);
    if(current.status!==200)return current;
    const principal=await resolve(current.user).catch(()=>undefined);
    if(principal===undefined)return {status:503};
    if(!principal)return {status:403,code:'ORGANIZATION_REQUIRED'};
    const {user}=current;
    return {status:200,user:{id:user.id,email:user.email},principal:{...principal,email:user.email,name:[user.firstName,user.lastName].filter(Boolean).join(' ')||null}};
  }

  /** Handles an auth route and returns true, or false for other paths. */
  async function route(req:IncomingMessage,res:ServerResponse,target:URL):Promise<boolean>{
    const path=target.pathname;
    if(path.startsWith('/api/auth/')){
      if(PUBLIC.get(path)!==req.method){json(res,404,{error:'not_found'});return true;}
      await handler(req,res);return true;
    }
    if(['/.well-known/oauth-authorization-server','/.well-known/oauth-authorization-server/api/auth','/.well-known/openid-configuration','/.well-known/openid-configuration/api/auth','/api/auth/.well-known/openid-configuration'].includes(path)){
      res.setHeader('Access-Control-Allow-Origin','*');
      await relay(res,await (path.includes('openid')?openidMetadata:authorizationMetadata)(new Request(url+path)));return true;
    }
    if(path==='/api/cli/device'){await cliToken(req,res,'/device/code');return true;}
    if(path==='/api/cli/token'){await cliToken(req,res,'/oauth2/token');return true;}
    const forms=req.method==='GET'||req.method==='POST';
    if(forms&&req.method==='POST'&&req.headers.origin&&req.headers.origin!==url){json(res,403,{error:'Invalid request origin'});return true;}
    if(forms&&path==='/auth/login'){await login(req,res,target);return true;}
    if(forms&&path==='/auth/signup'){await signup(req,res,target);return true;}
    if(forms&&path==='/auth/consent'){await consent(req,res,target);return true;}
    if(forms&&path==='/device'){await device(req,res,target);return true;}
    if(forms&&path==='/auth/logout'){
      const response=await auth.api.signOut({headers:fromNodeHeaders(req.headers),asResponse:true}).catch(()=>null);
      forwardCookies(res,response?.headers);go(res,'/signed-out');return true;
    }
    return false;
  }
  const cliConfiguration=()=>({schemaVersion:1,auth:{clientId:CLI_CLIENT_ID,deviceAuthorizationEndpoint:url+'/api/cli/device',tokenEndpoint:url+'/api/cli/token'},index:{available:false}});
  return {route,browserIdentity,identifyToken,cliConfiguration,loginUrl};
}
