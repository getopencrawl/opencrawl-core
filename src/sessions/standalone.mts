import {standaloneEventIdentities} from './identity-migration.mjs';
import type {Principal, ObjectStore, EventIdentityStore, Authenticate, HttpHandler} from './types.mjs';
import type {SearchAdapter} from '../search/types.mjs';
import {createCaptureCredentials,isCaptureCredential} from './credentials.mjs';
import {createOnboardingStatus} from '../onboarding-status.mjs';
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createSessionIngest,createCaptureHandler} from './ingest.mjs';
import {createObjectStore,awsCredentials} from './s3-store.mjs';
import {createSessionSearch,searchSettings} from './search.mjs';

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
/** Same object format and S3 adapter as hosted ingestion; no filesystem fallback. */
export function standaloneStorage(env=process.env) {
  if(env.OPENCRAWL_SESSION_DIRECTORY)throw new Error('Filesystem session storage is no longer supported. Migrate existing objects to the configured S3 bucket before starting.');
  const bucket=env.OPENCRAWL_LANDING_S3_BUCKET;
  if(!bucket)throw new Error('OPENCRAWL_LANDING_S3_BUCKET is required; configure AWS S3 or an S3-compatible store.');
  const accessKeyId=env.OPENCRAWL_LANDING_S3_ACCESS_KEY_ID;
  const secretAccessKey=env.OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY;
  if(Boolean(accessKeyId)!==Boolean(secretAccessKey))throw new Error('Set both OPENCRAWL_LANDING_S3_ACCESS_KEY_ID and OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY.');
  const prefix=(env.OPENCRAWL_LANDING_S3_PATH||'sessions/self-hosted/v1').replace(/^\/+|\/+$/g,'');
  if(!prefix||prefix.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid OPENCRAWL_LANDING_S3_PATH');
  const store=createObjectStore({bucket,endpoint:env.OPENCRAWL_LANDING_S3_ENDPOINT||undefined,
    region:env.OPENCRAWL_LANDING_S3_REGION||'us-east-1',
    credentials:accessKeyId?{accessKeyId,secretAccessKey: secretAccessKey!,sessionToken:env.OPENCRAWL_LANDING_S3_SESSION_TOKEN||undefined}:awsCredentials({env})});
  return {store,prefix};
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
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  await startStandaloneCapture();
}
