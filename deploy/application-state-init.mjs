import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

export function bundledCredentialPrefix(env,volume='/run/opencrawl-bundled-source') {
  const prefix='sessions/self-hosted/v1';
  if(env.OPENCRAWL_LANDING_S3_ENDPOINT!=='http://s3:8333' || env.OPENCRAWL_LANDING_S3_BUCKET!=='opencrawl' ||
     (env.OPENCRAWL_LANDING_S3_PATH||prefix)!==prefix)return;
  const marker=join(volume,'.opencrawl-initial-owner');
  if(!existsSync(marker))return;
  if(readFileSync(marker,'utf8')!==env.OPENCRAWL_ORGANIZATION_ID+'\n')
    throw Error('This SeaweedFS volume belongs to a different organization. Restore the original deployment environment and database before starting writers.');
  return prefix;
}
if(import.meta.main){
  await import('./wait-storage.mjs');
  // This one-shot service creates the application-state schema on a fresh
  // installation and is a no-op afterwards. Writers start only after it verifies.
  const leftover = process.env.OPENCRAWL_IDENTITY_PATH || '/data/identity.sqlite';
  if (existsSync(leftover)) console.warn(`WARNING: ${leftover} is from a pre-PostgreSQL release and is ignored. There is no upgrade path; this installation starts empty.`);
  const env={...process.env},prefix=bundledCredentialPrefix(env);
  if(prefix)env.OPENCRAWL_ALLOCATED_LANDING_PREFIX=prefix;
  for (const command of ['initialize', 'verify']) {
    const result=spawnSync(process.execPath,['dist/src/state/initialize.mjs',command],{stdio:'inherit',env});
    if(result.error || result.status!==0)throw Error(`Application state ${command} failed; writers stay stopped.`);
  }
}
