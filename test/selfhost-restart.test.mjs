import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('MCP and CLI grants survive a process restart and expired access tokens without reopening enrollment',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-restart-'));
  const config={dir,secret:randomBytes(32).toString('hex'),setup:randomBytes(32).toString('hex')};
  const children=[];
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}
    await rm(dir,{recursive:true,force:true});
  });
  async function start(extra={}){
    const child=fork(new URL('./fixtures/selfhost-restart-server.mjs',import.meta.url),[],{
      env:{PATH:process.env.PATH,OPENCRAWL_RESTART_TEST:JSON.stringify({...config,...extra})},
      stdio:['ignore','ignore','pipe','ipc'],execArgv:[],
    });
    children.push(child);let error='';child.stderr.on('data',chunk=>{error+=chunk;});
    const ready=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Self-host startup timed out: '+error)),15000);
      child.once('message',message=>{clearTimeout(timer);resolve(message);});
      child.once('error',cause=>{clearTimeout(timer);reject(cause);});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error('Self-host exited '+code+': '+error));});
    });
    return {child,...ready};
  }
  async function stop(child){const exit=once(child,'exit');child.kill('SIGTERM');assert.deepEqual(await exit,[0,null]);}
  const first=await start(),origin='http://localhost:'+first.port;
  const cookies=new Map();
  async function request(path,options={},browser=false){
    const response=await fetch(origin+path,{redirect:'manual',...options,headers:{...options.headers,
      ...(browser?{cookie:[...cookies].map(([key,value])=>key+'='+value).join('; ')}:{})}});
    if(browser)for(const line of response.headers.getSetCookie()){
      const pair=line.split(';')[0],split=pair.indexOf('=');cookies.set(pair.slice(0,split),pair.slice(split+1));
    }
    return response;
  }
  const form=(path,fields,browser=false)=>request(path,{method:'POST',headers:{...(browser?{origin}:{}),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)},browser);
  const json=async(response,status=200)=>{assert.equal(response.status,status);return response.json();};
  const mcp=token=>request('/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'restart-test',version:'1'}}})});
  const me=token=>request('/api/cli/me',{headers:{authorization:'Bearer '+token}});
  const signup={setup:config.setup,workspace:'Restart test',name:'Restart Admin',email:'restart@example.com',password:'a long disposable password'};
  const signedUp=await form('/auth/signup',signup,true);
  assert.equal(signedUp.status,303);
  assert.match(signedUp.headers.getSetCookie().find(line=>line.includes('session_token=')),/Max-Age=2592000(?:;|$)/);
  const callback='claude://claude.ai/mcp-auth-callback/sdk';
  const client=await json(await request('/api/auth/oauth2/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    client_name:'Restart test',redirect_uris:[callback],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],
  })}),201);
  const verifier=randomBytes(32).toString('base64url');
  const authorization=await request('/api/auth/oauth2/authorize?'+new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:callback,
    scope:'openid offline_access',state:'restart',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource:origin+'/mcp'}),{},true);
  const consent=new URL(authorization.headers.get('location')||(await authorization.json()).url,origin);
  assert.equal(consent.pathname,'/auth/consent');
  const accepted=await form('/auth/consent',{oauth_query:consent.searchParams.toString(),accept:'true'},true);
  assert.equal(accepted.status,200);
  const page=JSON.parse(/<script[^>]+id="opencrawl-page"[^>]*>(.*?)<\/script>/s.exec(await accepted.text())[1]).page;
  const returned=new URL(page.url);assert.equal(returned.searchParams.get('state'),'restart');
  const native=await json(await form('/api/auth/oauth2/token',{grant_type:'authorization_code',code:returned.searchParams.get('code'),redirect_uri:callback,client_id:client.client_id,code_verifier:verifier,resource:origin+'/mcp'}));
  assert.ok(native.refresh_token);assert.equal((await mcp(native.access_token)).status,200);
  const device=await json(await form('/api/cli/device',{client_id:'opencrawl-cli'}));
  assert.match(await (await form('/device',{user_code:device.user_code,decision:'approve'},true)).text(),/CLI connected/);
  const cli=await json(await form('/api/cli/token',{client_id:'opencrawl-cli',grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:device.device_code}));
  assert.equal((await me(cli.access_token)).status,200);
  const keys=await json(await request('/api/auth/jwks'));

  await stop(first.child);
  const second=await start({port:first.port});assert.notEqual(second.pid,first.pid);
  assert.deepEqual(await json(await request('/api/auth/jwks')),keys,'signing keys survive restart');
  assert.equal((await mcp(native.access_token)).status,200);
  assert.equal((await me(cli.access_token)).status,200);
  assert.equal((await request('/api/console/bootstrap',{},true)).status,200,'browser session survives restart');
  assert.equal((await form('/auth/signup',{...signup,email:'other@example.com'},true)).status,403,'bootstrap remains consumed');

  await stop(second.child);
  const payload=token=>JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
  const afterExpiry=(Math.max(payload(native.access_token).exp,payload(cli.access_token).exp)+10)*1000;
  const third=await start({port:first.port,now:afterExpiry});assert.notEqual(third.pid,second.pid);
  assert.equal((await mcp(native.access_token)).status,401,'expired access is rejected');
  assert.equal((await me(cli.access_token)).status,401);
  const refreshedNative=await json(await form('/api/auth/oauth2/token',{grant_type:'refresh_token',client_id:client.client_id,refresh_token:native.refresh_token,resource:origin+'/mcp'}));
  const refreshedCli=await json(await form('/api/cli/token',{grant_type:'refresh_token',client_id:'opencrawl-cli',refresh_token:cli.refresh_token}));
  assert.equal((await mcp(refreshedNative.access_token)).status,200,'MCP refresh restores access after expiry and restart');
  assert.equal((await me(refreshedCli.access_token)).status,200);
  assert.notEqual(refreshedNative.refresh_token,native.refresh_token);
  assert.notEqual(refreshedCli.refresh_token,cli.refresh_token);
  assert.equal((await form('/api/auth/oauth2/revoke',{client_id:client.client_id,token:refreshedNative.refresh_token,token_type_hint:'refresh_token'})).status,200);

  await stop(third.child);
  const fourth=await start({port:first.port,now:afterExpiry+1000});
  // JWT access remains valid until expiry; revocation denies the persisted refresh grant.
  assert.equal((await mcp(refreshedNative.access_token)).status,200);
  assert.equal((await form('/api/auth/oauth2/token',{grant_type:'refresh_token',client_id:client.client_id,refresh_token:refreshedNative.refresh_token,resource:origin+'/mcp'})).status,400);
  assert.equal((await me(refreshedCli.access_token)).status,200,'revoking MCP does not revoke an independent CLI grant');

  await stop(fourth.child);
  const day=86400_000;
  const fifth=await start({port:first.port,now:afterExpiry+89*day});
  assert.equal((await request('/api/console/bootstrap',{},true)).status,401,'browser session expires after 30 days without activity');
  const activeCli=await json(await form('/api/cli/token',{grant_type:'refresh_token',client_id:'opencrawl-cli',refresh_token:refreshedCli.refresh_token}));
  assert.equal((await me(activeCli.access_token)).status,200,'device grant survives 89 days of inactivity and an expired browser session');

  await stop(fifth.child);
  const sixth=await start({port:first.port,now:afterExpiry+91*day});
  const renewedCli=await json(await form('/api/cli/token',{grant_type:'refresh_token',client_id:'opencrawl-cli',refresh_token:activeCli.refresh_token}));
  assert.equal((await me(renewedCli.access_token)).status,200,'rotation extends the device grant beyond its original 90-day lifetime');

  await stop(sixth.child);
  await start({port:first.port,now:afterExpiry+182*day});
  assert.equal((await form('/api/cli/token',{grant_type:'refresh_token',client_id:'opencrawl-cli',refresh_token:renewedCli.refresh_token})).status,400,'device grant expires after 90 days without refresh');
});
