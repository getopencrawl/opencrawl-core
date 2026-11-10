import {consoleRoute,consolePages} from './console.mjs';
export type Route = {name: string; status?: number; provider?: string; action?: 'connect' | 'retry' | 'disconnect'};
export function productRoute(method: string, path: string): Route | null {
  if (method === 'GET' && consolePages.has(path)) return {name:path};
  if (path.startsWith('/api/trpc/')) return ['GET','POST'].includes(method) ? {name:'web-rpc'} : {name:'web-rpc',status:405};
  const console = consoleRoute(method, path);
  if (console) return console;
  const only = (allowed: string, route: Route) => method === allowed ? route : {name: '', status: 405};
  if (['/onboarding','/onboarding/sources','/onboarding/invite','/api/onboarding/sources'].includes(path)) return only('GET', {name:path});
  if (path === '/api/onboarding/invites') return ['GET','POST'].includes(method)?{name:path}:{name: '', status:405};
  if (['/api/onboarding/finish','/api/workspace/search'].includes(path)) return only('POST',{name:path});
  if (path === '/' || path === '/api/hello' || path === '/api/onboarding' || path === '/integrations' || path === '/usage' || path === '/search') return only('GET', {name: path});
  if (path === '/_/debug' || path === '/_/debug/') return only('GET', {name: 'debug'});
  if (path === '/api/debug/search') return only('POST', {name: 'debug-search'});
  if (path === '/api/debug/board') return only('GET', {name: 'debug-board'});
  if (path === '/capture/cloud') return ['GET','POST'].includes(method)?{name:'cloud-capture'}:{name: '', status:405};
  if (path === '/capture/cloud/revoke') return only('POST',{name:'cloud-capture-revoke'});
  if (path === '/auth/logout') return only('POST', {name: path});
  if (path === '/api/integrations/disconnect-all') return only('POST', {name: path});
  let match = /^\/api\/integrations\/credentials\/([a-z0-9-]{1,40})$/.exec(path);
  if (match) return only('POST', {name: 'integration-credential', provider: match[1]});
  match = /^\/api\/integrations\/([a-z0-9-]{1,40})\/(connect|retry|disconnect)$/.exec(path);
  if (match) return only('POST', {name: 'integration-action', provider: match[1], action: match[2] as Route['action']});
  match = /^\/integrations\/([a-z0-9-]{1,40})\/callback$/.exec(path);
  if (match) return only('GET', {name: 'integration-callback', provider: match[1]});
  return null;
}
