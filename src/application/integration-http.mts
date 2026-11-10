import type {IncomingMessage} from 'node:http';
import type {Principal,DirectoryMembership} from '../identity/types.mjs';
import {isAdmin} from '../identity/team.mjs';
import type {Integrations} from '../integrations/service.mjs';
import type {ProviderCatalog} from '../integrations/types.mjs';
import type {createOnboardingStatus} from '../onboarding-status.mjs';
import type {createGuidedOnboarding} from './onboarding.mjs';
import type {Route} from './routes.mjs';
import {errorInfo} from '../errors.mjs';
import {hasReceipt} from '../onboarding-state.mjs';
import {callbackPage} from './integration-callback.mjs';
import {smallJson} from './http.mjs';
export async function integrationRequest(req: IncomingMessage,url: URL,route: Route, {
  integrations,providers,principal,member,onboarding,guided,respond,message,document,track=()=>{},log=()=>{},
}: {integrations?: Integrations | null; providers:ProviderCatalog;principal:Principal;member:DirectoryMembership;
  onboarding:ReturnType<typeof createOnboardingStatus>|null;guided:ReturnType<typeof createGuidedOnboarding>;
  respond(status:number,body:string,type?:string):void;
  message(status:number,heading:string,detail:string,href?:string,action?:string):void;
  document(page: ReturnType<typeof callbackPage>, options:{signedIn:boolean}):string;
  track?(name:string,principal:Principal,properties?:Record<string,unknown>):unknown;
  log?(event:string,detail:Record<string,unknown>):void}) {
      if (route.name.startsWith('/integrations') || route.name.startsWith('/api/integrations') || route.name.startsWith('integration-')) {
        const json = (status: number, body: unknown) => respond(status, JSON.stringify(body), 'application/json');
        if (!integrations) return url.pathname.startsWith('/api/') ? json(503, {error: {code: 'INTEGRATIONS_NOT_CONFIGURED', message: 'Integrations aren’t available yet.'}}) : message(503, 'Integrations aren’t available yet', 'Check back soon.', '/', 'Open OpenCrawl');
        if (!principal) return message(403, 'This account doesn’t have access', 'Your organization membership could not be verified. Sign in again to continue.');
        // Runtime adapters pass the current, verified membership. A role from a
        // different user/workspace cannot authorize changes to shared sources.
        const admin=member?.status==='active' && member.userId===principal.userId && member.organizationId===principal.tenantId && isAdmin(member);
        const adminRequired=()=>url.pathname.startsWith('/api/')
          ? json(403,{error:{code:'ADMIN_REQUIRED',message:'Only a workspace admin can change shared integrations.'}})
          : message(403,'Workspace admin access required','Ask a workspace admin to connect or change this integration.','/sources','Open Integrations');
        if (route.name === '/api/integrations/disconnect-all') {
          if(!admin)return adminRequired();
          try {
            const disconnected = await integrations.disconnectAll(principal);
            track('integrations_disconnected_all', principal, {count: Array.isArray(disconnected) ? disconnected.length : Number(disconnected) || 0});
            return json(200, {disconnected});
          }
          catch (error) {
            log('integration.action.failed',{action:'disconnect-all'});
            return json(503, {error: {code: 'INTEGRATION_UNAVAILABLE', message: 'We couldn’t disconnect everything. Please try again.'}});
          }
        }
        const provider = providers[route.provider || ''];
        if (!provider) return url.pathname.startsWith('/api/') ? json(404, {error: {code: 'UNKNOWN_INTEGRATION', message: 'Unknown integration.'}}) : message(404, 'Page not found', 'This page may have moved.', '/integrations', 'Open Integrations');
        if(provider.scope!=='user'&&!admin)return adminRequired();
        if (route.name === 'integration-callback') {
          const result = await integrations.complete(principal, provider.id, url.searchParams);
          if (!result.actions?.length) track(result.ok ? 'integration_connected' : 'integration_connect_failed', principal, {provider: provider.id, reason: result.ok ? null : result.reason || null});
          const inOnboarding = Boolean(onboarding && !hasReceipt((await guided.progress(principal))?.completed));
          const callback = callbackPage({...result,name:provider.name,returnTo:inOnboarding ? '/onboarding/sources' : '/sources'});
          return respond(result.ok || result.actions?.length ? 200 : 400, document(callback,{signedIn:true}), 'text/html; charset=utf-8');
        }
        try {
          if (route.action === 'connect') {
            const {apiKey} = provider.auth === 'api-key' ? await smallJson(req) : {};
            const result = await integrations.connect(principal, provider.id, {apiKey});
            track(provider.auth === 'api-key' && 'ok' in result && result.ok ? 'integration_connected' : 'integration_connect_started', principal, {provider: provider.id, auth: provider.auth === 'api-key' ? 'api_key' : 'oauth'});
            return json(200, result);
          }
          if (route.action === 'retry' || route.action === 'disconnect') await integrations[route.action](principal, provider.id);
          track(route.action === 'disconnect' ? 'integration_disconnected' : 'integration_sync_retried', principal, {provider: provider.id});
          return json(200, {ok: true});
        } catch (error) {
          // Our own 409s explain themselves (storage not ready, setup still running); only a live connection is "already connected".
          if (errorInfo(error).status === 409 && errorInfo(error).expose) return json(409, {error: {code: 'NOT_READY', message: errorInfo(error).message}});
          if (errorInfo(error).status === 409) return json(409, {error: {code: 'ALREADY_CONNECTED', message: `${provider.name} is already connected.`}});
          if (errorInfo(error).status === 404) return json(404, {error: {code: 'NOT_CONNECTED', message: `${provider.name} isn’t connected.`}});
          // Our own messages about the pasted key; never upstream text.
          if (errorInfo(error).expose) return json(400, {error: {code: 'INVALID_REQUEST', message: errorInfo(error).message}});
          log('integration.action.failed',{provider:provider.id,action:route.action});
          track('integration_action_failed', principal, {provider: provider.id, action: route.action});
          return json(503, {error: {code: 'INTEGRATION_UNAVAILABLE', message: 'We couldn’t reach that service. Please try again.'}});
        }
      }
}
