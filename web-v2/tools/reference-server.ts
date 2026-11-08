import {createServer} from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {join} from 'node:path';

export interface ReferenceConfiguration {password: string; token: string; upstream: string; name?: string; origin?: string; host?: string; port?: number}
const root=fileURLToPath(new URL('../',import.meta.url));
const shell='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>OpenCrawl</title><link rel="icon" href="/assets/opencrawl-mark.svg"><link rel="stylesheet" href="/console.css"><script type="module" src="/console.js"></script></head><body><div id="app"></div></body></html>';
function record(value: unknown): Record<string, unknown> {return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};}
function failure(message: string, status=400) {return Object.assign(new Error(message), {status});}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[]=[];let bytes=0;
  for await(const chunk of request) {const buffer=Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); bytes+=buffer.length;if(bytes>16384)throw failure('Request is too large.',413);chunks.push(buffer);}
  try {const parsed:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))throw failure('Send a JSON object.');return record(parsed);} catch(error) {if(error instanceof Error && 'status' in error)throw error;throw failure('Send valid JSON.');}
}
export function createReferenceServer(configuration: ReferenceConfiguration) {
  if(configuration.password.length<32 || configuration.token.length<32)throw new Error('Use separate console and MCP secrets of at least 32 characters.');
  const upstream=new URL(configuration.upstream);
  if(!['http:','https:'].includes(upstream.protocol)||upstream.username||upstream.password||upstream.search||upstream.hash||upstream.pathname!=='/')throw new Error('OPENCRAWL_MCP_URL must be the deployment origin, without credentials or a path.');
  if(configuration.origin && new URL(configuration.origin).origin !== configuration.origin)throw new Error('Use a canonical console origin.');
  const expected=Buffer.from('Basic '+Buffer.from('opencrawl:'+configuration.password).toString('base64'));
  const send=(response:ServerResponse,status:number,value:unknown)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
  const proxy=async(path:string,input:Record<string,unknown>)=>{
    const response=await fetch(new URL(path,upstream),{method:'POST',headers:{authorization:'Bearer '+configuration.token,'content-type':'application/json'},body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw failure(response.status===503 ? 'This service is unavailable. Check the deployment configuration and try again.' : 'The deployment refused this request. Verify its configuration and access.',response.status>=400&&response.status<500?response.status:503);
    const data:unknown=await response.json();return data;
  };
  const server=createServer(async(request,response)=>{
    response.setHeader('cache-control','no-store');response.setHeader('x-content-type-options','nosniff');response.setHeader('referrer-policy','no-referrer');
    response.setHeader('content-security-policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const address=server.address();const origin=configuration.origin || `http://127.0.0.1:${typeof address === 'object' && address ? address.port : configuration.port || 8094}`;
      if(request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site']==='cross-site')return send(response,403,{error:{message:'Request origin is not allowed.'}});
      const actual=Buffer.from(request.headers.authorization || '');
      if(actual.length!==expected.length||!timingSafeEqual(actual,expected)){response.setHeader('www-authenticate','Basic realm="OpenCrawl console", charset="UTF-8"');return send(response,401,{error:{message:'Sign in with the console password.'}});}
      const url=new URL(request.url || '/',origin);
      if(url.pathname==='/api/reference/config' && request.method==='GET')return send(response,200,{name:configuration.name || 'Local workspace',mcpEndpoint:new URL('/mcp',upstream).href});
      if(url.pathname==='/api/reference/agents' && request.method==='GET')return send(response,200,await proxy('/api/board/directory',{}));
      if(url.pathname==='/api/reference/search' || url.pathname==='/api/reference/fetch') {
        if(request.method!=='POST')return send(response,405,{error:{message:'Use POST for this request.'}});
        if(!request.headers['content-type']?.startsWith('application/json'))return send(response,415,{error:{message:'Send application/json.'}});
        const input=await readJson(request);
        if(url.pathname.endsWith('/search')) {
          if(Object.keys(input).some(key=>key!=='query')||typeof input.query!=='string'||!input.query.trim()||input.query.length>4000)throw failure('Enter a query of at most 4,000 characters.');
          return send(response,200,await proxy('/api/search',{query:input.query.trim(),limit:20}));
        }
        if(Object.keys(input).some(key=>key!=='id')||typeof input.id!=='string'||!input.id.trim()||input.id.length>1000)throw failure('Enter a passage ID from search.');
        return send(response,200,await proxy('/api/search/fetch',{id:input.id.trim(),length:16000}));
      }
      if(request.method!=='GET')return send(response,405,{error:{message:'Method not allowed.'}});
      const assets:Record<string,[string,string]>={'/console.js':[join(root,'dist/reference/console.js'),'text/javascript'],'/console.css':[join(root,'dist/styles.css'),'text/css'],...Object.fromEntries(['opencrawl-mark.svg','geist-sans.woff2','geist-mono.woff2'].map(name=>['/assets/'+name,[join(root,'../web/assets',name),name.endsWith('.svg')?'image/svg+xml':'font/woff2']]))};
      const asset=assets[url.pathname];
      if(asset){response.writeHead(200,{'content-type':asset[1]});response.end(await readFile(asset[0]));return;}
      if(['/','/diagnostics','/agents','/settings'].includes(url.pathname)){response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(shell);return;}
      return send(response,404,{error:{message:'Page not found.'}});
    }catch(error){if(response.headersSent){response.end();return;}const status=error instanceof Error && 'status' in error && typeof error.status==='number'?error.status:503;return send(response,status,{error:{message:status<500&&error instanceof Error?error.message:'The local service is unavailable. Check server configuration and retry.'}});}
  });
  server.requestTimeout=20000;server.headersTimeout=10000;
  return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const host=process.env.HOST || '127.0.0.1',port=Number(process.env.PORT || 8094),origin=process.env.OPENCRAWL_WEB_ORIGIN;
  if(!['127.0.0.1','::1','localhost'].includes(host) && (!origin || new URL(origin).protocol!=='https:'))throw new Error('Network exposure requires an HTTPS reverse proxy and OPENCRAWL_WEB_ORIGIN.');
  const server=createReferenceServer({host,port,origin,password:process.env.OPENCRAWL_WEB_PASSWORD || '',token:process.env.MCP_TOKEN || '',upstream:process.env.OPENCRAWL_MCP_URL || 'http://127.0.0.1:8093',name:process.env.OPENCRAWL_WORKSPACE_NAME});
  server.listen(port,host,()=>console.info('OpenCrawl console is listening.'));
  process.on('SIGTERM',()=>server.close());process.on('SIGINT',()=>server.close());
}
