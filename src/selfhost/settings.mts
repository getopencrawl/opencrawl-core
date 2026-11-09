import type {IdentitySettings} from '../identity/types.mjs';
export interface SelfhostSettings extends IdentitySettings {
  organizationId:string; apiKey:string; cookiePassword:string; revision?:string;
  registryPath:string; search:{endpoint:string;username?:string;password?:string;environment:string;tenantId:string};
}
/** Operator configuration; requests never choose a tenant or storage namespace. */
export function selfhostSettings(env:NodeJS.ProcessEnv=process.env):SelfhostSettings {
  const required=(name:string)=>{const value=env[name]?.trim();if(!value)throw new Error(`${name} is required`);return value;};
  const origin=(name:string)=>{const value=required(name),u=new URL(value);if(u.origin!==value || u.protocol!=='https:')throw new Error(`${name} must be an HTTPS origin`);return value;};
  const url=origin('OPENCRAWL_URL'),authOrigin=origin('WORKOS_AUTH_ORIGIN');
  const organizationId=required('WORKOS_ORGANIZATION_ID'),clientId=required('WORKOS_CLIENT_ID');
  if(!/^org_[A-Za-z0-9]+$/.test(organizationId)||!/^client_[A-Za-z0-9]+$/.test(clientId))throw new Error('Invalid WorkOS organization or client');
  const apiKey=required('WORKOS_API_KEY'),cookiePassword=required('WORKOS_COOKIE_PASSWORD');
  if(!apiKey.startsWith('sk_')||cookiePassword.length<32)throw new Error('Configure WorkOS API key and a cookie secret of at least 32 characters');
  const endpoint=required('OPENCRAWL_OPENSEARCH_URL'),u=new URL(endpoint);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('Invalid OpenSearch endpoint');
  const username=env.OPENCRAWL_OPENSEARCH_USERNAME,password=env.OPENCRAWL_OPENSEARCH_PASSWORD;
  if(Boolean(username)!==Boolean(password))throw new Error('Set both OpenSearch username and password');
  return {url,authOrigin,organizationId,clientId,apiKey,cookiePassword,revision:env.REVISION,
    registryPath:env.OPENCRAWL_REGISTRY_PATH||'/data/integrations.sqlite',
    search:{endpoint,username,password,environment:'selfhost',tenantId:organizationId}};
}
