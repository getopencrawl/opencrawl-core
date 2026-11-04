import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createSessionIngest,createCaptureHandler} from './ingest.mjs';
import {createLocalSessionStore} from './local-store.mjs';

/** Single-tenant adapter: the operator sets identity; requests cannot select an owner. */
export function standaloneCapture({token,principal,store}) {
  if(typeof token!=='string'||token.length<32)throw new Error('Use a capture token with at least 32 characters');
  const expected=Buffer.from('Bearer '+token);
  return createCaptureHandler({ingest:createSessionIngest({store}),authenticate:async req=>{
    const actual=Buffer.from(req.headers.authorization??'');
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;
    return principal;
  }});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const principal={tenantId:process.env.OPENCRAWL_TENANT_ID||'self-hosted',userId:process.env.OPENCRAWL_USER_ID||'owner',
    name:process.env.OPENCRAWL_USER_NAME||null,email:process.env.OPENCRAWL_USER_EMAIL||null};
  const server=createServer(standaloneCapture({token:process.env.OPENCRAWL_SESSIONS_TOKEN,principal,
    store:createLocalSessionStore(process.env.OPENCRAWL_SESSION_DIRECTORY||'./session-data')}));
  server.requestTimeout=60000;
  server.listen(Number(process.env.PORT||8093),process.env.HOST||'127.0.0.1');
}
