import {test,expect,type Page} from '@playwright/test';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {applicationDatabaseFixture,postgresUrl} from '../../test/fixtures/application-database.mjs';

// Real self-host HTTP, Better Auth and PostgreSQL, with disposable local raw objects.
// Only the explicitly configured test database is passed to the child process.
let origin:string,directory:string,server:ChildProcess;
let cleanups:Array<()=>Promise<void>>=[];
const password='disposable browser password',email='browser@example.com',setup='browser-test-setup-token-32-characters';
test.beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),'opencrawl-browser-auth-'));
  cleanups=[];
  const database=await applicationDatabaseFixture({after:cleanup=>cleanups.push(cleanup)});
  server=fork(new URL('../../test/fixtures/selfhost-restart-server.mjs',import.meta.url),[],{
    env:{PATH:process.env.PATH,OPENCRAWL_RESTART_TEST:JSON.stringify({dir:directory,secret:randomBytes(32).toString('hex'),setup,browser:true,connectionString:postgresUrl,namespace:database.namespace})},
    stdio:['ignore','ignore','pipe','ipc'],execArgv:[],
  });
  let errors='';server.stderr?.on('data',chunk=>{errors+=String(chunk);});
  const port=await new Promise<number>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Self-host startup timed out: '+errors)),15000);
    server.once('message',message=>{clearTimeout(timer);if(typeof message==='object'&&message!==null&&'port' in message&&typeof message.port==='number')resolve(message.port);else reject(new Error('Invalid startup receipt'));});
    server.once('error',error=>{clearTimeout(timer);reject(error);});
    server.once('exit',code=>{clearTimeout(timer);reject(new Error('Self-host exited '+code+': '+errors));});
  });
  origin='http://localhost:'+port;
});
test.afterEach(async()=>{
  try{if(server&&server.exitCode===null&&server.signalCode===null){const exited=once(server,'exit');server.kill('SIGTERM');await exited;}}
  finally{try{for(const cleanup of cleanups.reverse())await cleanup();}finally{await rm(directory,{recursive:true,force:true});}}
});

async function signup(page:Page){
  await page.goto(origin+'/auth/signup?setup='+setup);
  await page.getByLabel('Workspace name').fill('Browser test');await page.getByLabel('Your name').fill('Browser Admin');
  await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password (10+ characters)').fill(password);
  await page.getByRole('button',{name:'Create workspace'}).click();await page.waitForURL(origin+'/');
}
const form=(path:string,fields:Record<string,string>)=>fetch(origin+path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)});
async function authorization(prompt?:string){
  const callback='http://localhost:19837/callback',verifier=randomBytes(32).toString('base64url');
  const registered=await fetch(origin+'/api/auth/oauth2/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    client_name:'Claude Code browser test',redirect_uris:[callback],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],
  })});
  expect(registered.status).toBe(201);const client=await registered.json() as {client_id:string};
  const query=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:callback,scope:'openid offline_access',state:'browser-test',
    code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource:origin+'/mcp',...(prompt?{prompt}:{})});
  return {url:origin+'/api/auth/oauth2/authorize?'+query,callback,verifier,clientId:client.client_id};
}

test('first-user session persists through CLI approval, return to the workspace, MCP consent and logout',async({page,context},testInfo)=>{
  await signup(page);
  const session=async()=>(await context.cookies()).find(cookie=>cookie.name.endsWith('.session_token'))?.value;
  const originalSession=await session();expect(originalSession).toBeTruthy();
  const device=await(await form('/api/cli/device',{client_id:'opencrawl-cli'})).json() as {device_code:string;verification_uri_complete:string};
  const approval=await context.newPage();await approval.goto(device.verification_uri_complete);
  await expect(approval.getByRole('heading',{name:'Connect the OpenCrawl CLI'})).toBeVisible();
  await approval.getByRole('button',{name:'Connect',exact:true}).click();
  await expect(approval.getByRole('heading',{name:'CLI connected'})).toBeVisible();
  await expect(approval.getByRole('link',{name:'Sign in',exact:true})).toHaveCount(0);
  await approval.screenshot({path:testInfo.outputPath('cli-connected.png')});
  await approval.getByRole('link',{name:'Return to OpenCrawl'}).click();await approval.waitForURL(origin+'/');
  expect(await session()).toBe(originalSession);
  const cli=await(await form('/api/cli/token',{client_id:'opencrawl-cli',grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:device.device_code})).json() as {access_token:string};
  expect((await fetch(origin+'/api/cli/me',{headers:{authorization:'Bearer '+cli.access_token}})).status).toBe(200);
  // An old login tab or bookmarked sign-in link must also preserve this session.
  await approval.goto(origin+'/auth/login?next='+encodeURIComponent('/setup'));
  await expect(approval).toHaveURL(origin+'/setup');
  await expect(approval.getByLabel('Password',{exact:true})).toHaveCount(0);
  const oauth=await authorization();await approval.route(oauth.callback+'**',route=>route.fulfill({contentType:'text/plain',body:'Client callback'}));
  await approval.goto(oauth.url);
  await expect(approval.getByRole('heading',{name:'Allow Claude Code browser test to use OpenCrawl?'})).toBeVisible();
  await approval.getByRole('button',{name:'Allow',exact:true}).click();await approval.waitForURL(oauth.callback+'**');
  const callback=new URL(approval.url());expect(callback.searchParams.get('state')).toBe('browser-test');
  const code=callback.searchParams.get('code');expect(code).toBeTruthy();
  const exchanged=await form('/api/auth/oauth2/token',{grant_type:'authorization_code',code:code!,redirect_uri:oauth.callback,client_id:oauth.clientId,code_verifier:oauth.verifier,resource:origin+'/mcp'});
  expect(exchanged.status).toBe(200);const token=await exchanged.json() as {access_token:string};
  const mcp=await fetch(origin+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token.access_token,'content-type':'application/json',accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'browser-test',version:'1'}}})});
  expect(mcp.status).toBe(200);await mcp.body?.cancel();
  expect(await session()).toBe(originalSession);
  await page.reload();expect((await context.request.get(origin+'/api/console/bootstrap')).status()).toBe(200);
  // Use the real sign-out form on a focused authenticated document.
  await page.goto(device.verification_uri_complete);await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.getByRole('heading',{name:'You’re signed out'})).toBeVisible();
  expect((await context.request.get(origin+'/api/console/bootstrap')).status()).toBe(401);
  await page.goto(origin+'/auth/login');await expect(page.getByLabel('Password',{exact:true})).toBeVisible();
  await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(origin+'/');
  expect((await context.request.get(origin+'/api/console/bootstrap')).status()).toBe(200);
});

test('an OAuth client can still explicitly require a fresh sign-in',async({page})=>{
  await signup(page);const oauth=await authorization('login');await page.goto(oauth.url);
  await expect(page.getByRole('heading',{name:'Sign in to OpenCrawl'})).toBeVisible();
  await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Allow Claude Code browser test to use OpenCrawl?'})).toBeVisible();
});
