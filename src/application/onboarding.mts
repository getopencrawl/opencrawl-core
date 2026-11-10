import {errorInfo} from '../errors.mjs';
import type {IncomingMessage} from 'node:http';
import type {Principal, HostedUser, DirectoryMembership as Membership} from '../identity/types.mjs';
import type {createOnboardingStatus} from '../onboarding-status.mjs';
import type {createWorkspaceSearch} from '../search/workspace.mjs';
import type {Integrations} from '../integrations/service.mjs';
import type {teamService} from '../identity/team.mjs';
import type {SourceCard} from './types.mjs';
interface GuidedOptions {
  onboarding: ReturnType<typeof createOnboardingStatus> | null; integrations?: Pick<Integrations, 'list'>;
  organizations: ReturnType<typeof teamService>; authorizedSearch?: ReturnType<typeof createWorkspaceSearch>;
  track?: (name: string, principal: Principal) => unknown; smallJson(req: IncomingMessage, limit?: number): Promise<Record<string, unknown>>;
  /** A runtime whose connectors need operator setup may open the workspace on agent capture alone. */
  sourcesOptional?: boolean;
}
interface GuidedContext {route: {name: string}; principal: Principal; identity: {user: HostedUser}; member: Membership; respond(status: number, body: string, type?: string): void}
import {deriveOnboarding,hasReceipt} from '../onboarding-state.mjs';

/** Product onboarding uses persisted receipts; the runtime owns request admission. */
export function createGuidedOnboarding({onboarding,integrations,organizations,authorizedSearch,track = () => {},smallJson,sourcesOptional = false}: GuidedOptions) {
  const progress = async (principal: Principal) => onboarding ? onboarding.read(principal) : null;
  const sourceCards = async (principal: Principal) => integrations ? integrations.list(principal) : [];
  const connectedSource = (cards: SourceCard[]) => cards.some(card => ['syncing','synced','connected'].includes(card.state));
  const requiredSetup = async (principal: Principal) => {
    const state = await progress(principal);
    if (!state || !deriveOnboarding(state).complete) return '/onboarding';
    return connectedSource(await sourceCards(principal)) ? '/onboarding/invite' : '/onboarding/sources';
  };
  return {progress, next:requiredSetup, sourcesOptional,
    handles: (name: string) => name.startsWith('/api/onboarding/') || name === '/api/workspace/search',
    async handle(req: IncomingMessage, {route,principal,identity,member,respond}: GuidedContext) {
      const json = (status: number,value: unknown) => respond(status,JSON.stringify(value),'application/json');
      if (!onboarding) return json(503,{error:'Setup status is temporarily unavailable.'});
      const state = (await progress(principal))!;
      if (!deriveOnboarding(state).complete && !hasReceipt(state.completed)) {
        return json(409,{error:'Complete agent setup first.',onboardingUrl:'/onboarding'});
      }
      if (route.name === '/api/onboarding/sources') {
        const items = (await sourceCards(principal)).map(card => ({id:card.provider,name:card.name,icon:`/assets/connectors/${card.provider}.svg`,state:card.state,auth:card.auth,keyHelp:card.keyHelp,setup:card.setup}));
        return json(200,{items,...(sourcesOptional?{optional:true}:{})});
      }
      if (route.name === '/api/workspace/search') {
        if (!hasReceipt(state.completed)) return json(409,{error:'Finish setup to open your workspace.',onboardingUrl:await requiredSetup(principal)});
        if (!authorizedSearch) return json(503,{error:'Workspace search is temporarily unavailable.'});
        try {return json(200,await authorizedSearch.search(principal,await smallJson(req,16384)));}
        catch(error) {return json([400,401,403].includes(errorInfo(error).status || 0)?errorInfo(error).status!:503,{error:errorInfo(error).status===400?'Enter a valid search query.':'We couldn’t search your workspace. Try again.'});}
      }
      if (route.name === '/api/onboarding/finish' && hasReceipt(state.completed)) return json(200,{workspaceUrl:'/'});
      if (!sourcesOptional && !connectedSource(await sourceCards(principal))) return json(409,{error:'Connect at least one source.',onboardingUrl:'/onboarding/sources'});
      if (route.name === '/api/onboarding/finish') {await onboarding.complete(principal);track('onboarding_completed',principal);return json(200,{workspaceUrl:'/'});}
      if (route.name === '/api/onboarding/invites') {
        try {
          await organizations.requireAdmin(identity.user,principal.tenantId,member);
          const list = () => organizations.pendingInvitations(identity.user,principal.tenantId,member);
          if (req.method === 'GET') return json(200,{items:await list()});
          const body = await smallJson(req);
          if (typeof body.email !== 'string') return json(400,{error:'Enter one teammate email address.'});
          const previous = await list();
          if (previous.some(invite => invite.email.toLowerCase() === (body.email as string).trim().toLowerCase())) return json(200,{items:previous,addedCount:0});
          const invitation = await organizations.invite(identity.user,principal.tenantId,body.email,member);
          track('organization_invitation_sent',principal);
          return json(200,{items:[...previous,{email:invitation.email,...(invitation.acceptInvitationUrl?{inviteUrl:invitation.acceptInvitationUrl}:{})}],addedCount:1});
        } catch(error) {return json(errorInfo(error).expose?errorInfo(error).status || 503:503,{error:errorInfo(error).expose?errorInfo(error).message:'We couldn’t send that invitation. Try again.'});}
      }

    },
  };
}
