import {AsyncLocalStorage} from 'node:async_hooks';
import {apiOrigin, CliError, DEFAULT_API_ORIGIN} from './oauth.ts';

// A saved capture destination is not authority to send a newly supplied secret.
// Tokens default to cloud. Scope overrides to this invocation, including its
// background capture work, so a saved destination cannot redirect the token.
const destination = new AsyncLocalStorage<string>();
export function withEnvironmentTokenOrigin<T>(origin: string | undefined, operation: () => T): T {
  return destination.run(origin === undefined ? DEFAULT_API_ORIGIN : apiOrigin(origin), operation);
}

export function environmentToken(name: 'OPENCRAWL_TOKEN' | 'OPENCRAWL_SESSIONS_TOKEN', api: string): string | undefined {
  const token = process.env[name];
  if (!token) return undefined;
  const configured = destination.getStore() ?? process.env.OPENCRAWL_API_URL ?? DEFAULT_API_ORIGIN;
  if (apiOrigin(configured) !== apiOrigin(api)) throw new CliError('TOKEN_DESTINATION_MISMATCH', 'The environment token is bound to a different deployment. Use that deployment or remove the environment token to use saved credentials.', 64);
  return token;
}
