import {standaloneEventIdentities} from '../../src/sessions/postgres-identities.mjs';
import type {Principal, ObjectStore, EventIdentityStore, Authenticate, HttpHandler} from '../../src/sessions/types.mjs';
import type {SearchAdapter} from '../../src/search/types.mjs';
import {createCaptureCredentials,isCaptureCredential} from '../../src/sessions/credentials.mjs';
import {createOnboardingStatus} from '../../src/onboarding-status.mjs';
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {createSessionIngest,createCaptureHandler} from '../../src/sessions/ingest.mjs';
import {sessionStorage as standaloneStorage} from '../../src/sessions/storage.mjs';
import {createSessionSearch,searchSettings} from '../../src/sessions/search.mjs';

/** Single-tenant adapter: the operator sets identity; requests cannot select an owner. */
export function standaloneCapture({token,principal,store,eventIdentities,prefix='capture-v1',search=undefined}: {token?: string; principal: Principal; store: ObjectStore; eventIdentities?: EventIdentityStore; prefix?: string; search?: SearchAdapter | null}): HttpHandler {
  if(typeof token!=='string'||token.length<32)throw new Error('Use a capture token with at least 32 characters');
  const expected=Buffer.from('Bearer '+token);
  const credentials=createCaptureCredentials({store,prefix});
  const onboarding = createOnboardingStatus({store,prefix});
  const authenticate: Authenticate = async req=>{
    const bearer=(req.headers.authorization??'').replace(/^Bearer /,'');
    if(isCaptureCredential(bearer)) {
      const delegated=await credentials.authenticate(bearer);
      // An operator changing the fixed identity invalidates old delegations.
      return delegated?.tenantId===principal.tenantId && delegated?.userId===principal.userId ? {...principal,captureAccess:'write'} : null;
    }
    const actual=Buffer.from(req.headers.authorization??'');
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;
    return principal;
  };
  const capture = createCaptureHandler({ingest:createSessionIngest({store,eventIdentities,prefix,onStored:onboarding.session}),search,authenticate,credentials});
  return async (req,res) => {
    try {
    if (req.headers.origin) {res.writeHead(403);res.end();return;}
    if (req.method === 'GET' && ['/api/onboarding','/api/sessions/identity'].includes(req.url ?? '')) {
      const user = await authenticate(req);
      if (!user) {res.writeHead(401);res.end();return;}
      if (req.url === '/api/onboarding') {
        if (user.captureAccess === 'write') {res.writeHead(403, {'cache-control':'no-store'});res.end();return;}
        res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
        res.end(JSON.stringify({data:await onboarding.read(user)}));return;
      }
      if (!req.headers.origin) await onboarding.cli(user);
    }
    return await capture(req,res);
    } catch {
      if (!res.headersSent) res.writeHead(503, {'content-type':'application/json'});
      res.end(JSON.stringify({error:{code:'STATUS_UNAVAILABLE'}}));
    }
  };
}
export async function startStandaloneCapture(env=process.env) {
  const principal={tenantId:env.OPENCRAWL_TENANT_ID||'self-hosted',userId:env.OPENCRAWL_USER_ID||'owner',
    name:env.OPENCRAWL_USER_NAME||null,email:env.OPENCRAWL_USER_EMAIL||null};
  const {store,prefix}=standaloneStorage(env);
  const settings=searchSettings(env),search=settings?createSessionSearch({...settings,store,prefix}):null;
  const eventIdentities=standaloneEventIdentities(store,env);await eventIdentities.ready();
  const handler=standaloneCapture({token:env.OPENCRAWL_SESSIONS_TOKEN,principal,store,eventIdentities,prefix,search});
  await store.checkAccess();
  const server=createServer(handler);
  server.once('close',()=>{void eventIdentities.close();});
  server.requestTimeout=60000;
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(Number(env.PORT||8093),env.HOST||'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});
  });
  return server;
}
