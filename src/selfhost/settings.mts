import type {IdentitySettings} from '../identity/types.mjs';
import {CLI_CLIENT_ID} from '../identity/better-auth.mjs';
export interface SelfhostSettings extends IdentitySettings {
  organizationId:string; authSecret:string; identityPath:string; setupToken:string; revision?:string;
  registryPath:string; search:{endpoint:string;username?:string;password?:string;environment:string;tenantId:string};
}
const LOOPBACK=new Set(['localhost','127.0.0.1','[::1]']);
/** Operator configuration; requests never choose a tenant or storage namespace. */
export function selfhostSettings(env:NodeJS.ProcessEnv=process.env):SelfhostSettings {
  const required=(name:string)=>{const value=env[name]?.trim();if(!value)throw new Error(`${name} is required`);return value;};
  // HTTPS, or plain HTTP on this machine for a local trial.
  const url=required('OPENCRAWL_URL'),u=new URL(url);
  if(u.origin!==url||!(u.protocol==='https:'||u.protocol==='http:'&&LOOPBACK.has(u.hostname)))throw new Error('OPENCRAWL_URL must be an HTTPS origin, or http://localhost');
  const organizationId=required('OPENCRAWL_ORGANIZATION_ID');
  if(!/^org_[A-Za-z0-9]+$/.test(organizationId))throw new Error('Invalid OPENCRAWL_ORGANIZATION_ID');
  const authSecret=required('OPENCRAWL_AUTH_SECRET');
  if(authSecret.length<32)throw new Error('OPENCRAWL_AUTH_SECRET must be at least 32 characters');
  if(required('OPENCRAWL_SETUP_TOKEN').length<32)throw new Error('OPENCRAWL_SETUP_TOKEN must be at least 32 characters');
  const endpoint=required('OPENCRAWL_OPENSEARCH_URL'),search=new URL(endpoint);
  if(!['http:','https:'].includes(search.protocol)||search.username||search.password||search.search||search.hash)throw new Error('Invalid OpenSearch endpoint');
  const username=env.OPENCRAWL_OPENSEARCH_USERNAME,password=env.OPENCRAWL_OPENSEARCH_PASSWORD;
  if(Boolean(username)!==Boolean(password))throw new Error('Set both OpenSearch username and password');
  return {url,authOrigin:url+'/api/auth',clientId:CLI_CLIENT_ID,organizationId,authSecret,revision:env.REVISION,
    identityPath:env.OPENCRAWL_IDENTITY_PATH||'/data/identity.sqlite',setupToken:required('OPENCRAWL_SETUP_TOKEN'),
    registryPath:env.OPENCRAWL_REGISTRY_PATH||'/data/integrations.sqlite',
    search:{endpoint,username,password,environment:'selfhost',tenantId:organizationId}};
}
