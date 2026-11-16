import {createApplicationDatabase} from './postgres.mjs';

export interface ApplicationSourceIdentity {
  version: 1;
  bucket: string;
  prefix: string;
  organizationId: string | null;
}

/** Endpoint URLs and credentials can rotate without creating a new installation.
 * Operators sharing a bucket across independent sources must give each source
 * its own prefix, or explicitly choose an independent stable namespace. */
export function applicationStateSettings(env: NodeJS.ProcessEnv = process.env) {
  const connectionString = env.OPENCRAWL_DATABASE_URL;
  if (!connectionString) throw new Error('OPENCRAWL_DATABASE_URL is required for application state');
  const bucket = env.OPENCRAWL_LANDING_S3_BUCKET;
  if (!bucket) throw new Error('OPENCRAWL_LANDING_S3_BUCKET is required to bind application state');
  const prefix = (env.OPENCRAWL_LANDING_S3_PATH || 'sessions/self-hosted/v1').replace(/^\/+|\/+$/g, '');
  if (!prefix || prefix.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid application-state source prefix');
  const namespace = env.OPENCRAWL_APP_STATE_NAMESPACE || JSON.stringify([bucket, prefix]);
  const source: ApplicationSourceIdentity = {version: 1, bucket, prefix, organizationId: env.OPENCRAWL_ORGANIZATION_ID || null};
  return {connectionString, namespace, source,
    identityPath: env.OPENCRAWL_IDENTITY_PATH || '/data/identity.sqlite',
    registryPath: env.OPENCRAWL_REGISTRY_PATH || '/data/integrations.sqlite'};
}

export function applicationDatabase(env: NodeJS.ProcessEnv = process.env) {
  const {connectionString, namespace,source} = applicationStateSettings(env);
  return createApplicationDatabase({connectionString, namespace,sourceIdentity:source});
}
