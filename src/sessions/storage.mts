import {createObjectStore,awsCredentials} from './s3-store.mjs';

/** Same object format and S3 adapter as hosted ingestion; no filesystem fallback. */
export function sessionStorage(env=process.env) {
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
