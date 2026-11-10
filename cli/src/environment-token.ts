import {AsyncLocalStorage} from 'node:async_hooks';
import {apiOrigin, CliError} from './oauth.ts';

// A saved capture destination is not authority to send a newly supplied secret.
// Scope --api to this invocation, including its background capture work.
const destination = new AsyncLocalStorage<string>();
export function withEnvironmentTokenOrigin<T>(origin: string | undefined, operation: () => T): T {
  return destination.run(origin === undefined ? '' : apiOrigin(origin), operation);
}

export function environmentToken(name: 'OPENCRAWL_TOKEN' | 'OPENCRAWL_SESSIONS_TOKEN', api: string): string | undefined {
  const token = process.env[name];
  if (!token) return undefined;
  const configured = destination.getStore() ?? process.env.OPENCRAWL_API_URL;
  if (!configured) throw new CliError('TOKEN_DESTINATION_REQUIRED', `Set --api or OPENCRAWL_API_URL explicitly when using ${name}.`, 64);
  if (apiOrigin(configured) !== apiOrigin(api)) throw new CliError('TOKEN_DESTINATION_MISMATCH', 'The environment token is bound to a different deployment. Use that deployment or remove the environment token to use saved credentials.', 64);
  return token;
}
