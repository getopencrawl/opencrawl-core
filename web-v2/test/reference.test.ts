import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {Server} from 'node:http';
import {createReferenceServer} from '../tools/reference-server.ts';
const password='console-secret-for-test-only-32-characters',token='agent-token-for-test-only-32-characters';
const auth='Basic '+Buffer.from('opencrawl:'+password).toString('base64');
async function listen(server:Server){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});const address=server.address();if(typeof address!=='object'||!address)throw new Error('Missing listen address.');return `http://127.0.0.1:${address.port}`;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}

test('single-tenant console requires its own auth, fixes upstream scope and denies cross-origin requests',async context=>{
  const received:Array<{path:string;authorization:string|undefined;body:unknown}>=[];
  const upstream=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));received.push({path:req.url||'',authorization:req.headers.authorization,body:JSON.parse(Buffer.concat(chunks).toString())});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data:{results:[{id:'sessions:one',source:'sessions',title:'Recorded source',text:'Original evidence',provenance:{tenantId:'fixed-workspace'}}],coverage:[{source:'sessions',state:'ready'}]}}));});
  const upstreamUrl=await listen(upstream),server=createReferenceServer({password,token,upstream:upstreamUrl});const base=await listen(server);
  context.after(async()=>{await close(server);await close(upstream);});
  assert.equal((await fetch(base+'/api/reference/config')).status,401);
  const config=await fetch(base+'/api/reference/config',{headers:{authorization:auth}});assert.equal(config.status,200);assert.ok(!(await config.text()).includes(token));
  assert.equal((await fetch(base+'/api/reference/search',{method:'POST',headers:{authorization:auth,origin:'https://untrusted.example','content-type':'application/json'},body:JSON.stringify({query:'evidence'})})).status,403);
  assert.equal((await fetch(base+'/api/reference/search',{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify({query:'evidence',tenantId:'foreign-workspace'})})).status,400);
  assert.equal(received.length,0);
  const found=await fetch(base+'/api/reference/search',{method:'POST',headers:{authorization:auth,origin:base,'content-type':'application/json'},body:JSON.stringify({query:'evidence'})});assert.equal(found.status,200);assert.match(await found.text(),/Original evidence/);
  assert.deepEqual(received,[{path:'/api/search',authorization:'Bearer '+token,body:{query:'evidence',limit:20}}]);
  const fetched=await fetch(base+'/api/reference/fetch',{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify({id:'sessions:one'})});assert.equal(fetched.status,200);assert.deepEqual(received[1]?.body,{id:'sessions:one',length:16000});
  assert.equal((await fetch(base+'/api/reference/search',{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify({query:'a'.repeat(17000)})})).status,413);
});

test('single-tenant configuration cannot leak tokens through credential URLs or weak passwords',()=>{
  assert.throws(()=>createReferenceServer({password:'short',token,upstream:'http://127.0.0.1:8093'}));
  assert.throws(()=>createReferenceServer({password,token,upstream:'https://user:secret@example.com'}));
  assert.throws(()=>createReferenceServer({password,token,upstream:'https://example.com/other-scope'}));
});
