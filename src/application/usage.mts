import {errorInfo} from '../errors.mjs';
import type {Principal, Workos, HostedUser} from '../identity/types.mjs';
import type {Log} from '../integrations/ports.mjs';
import type {Integrations} from '../integrations/service.mjs';
import type {createSessionSearch} from '../sessions/search.mjs';
import type {createOnboardingStatus, OnboardingReceipts} from '../onboarding-status.mjs';
import {indexedSourceInventory} from './usage-inventory.mjs';
type Sessions = Pick<ReturnType<typeof createSessionSearch>, 'usage' | 'search'>;
interface ConnectionCount {total: number; kinds: Record<string, number>}
interface Connectors {count(principal: Principal): Promise<ConnectionCount & {providers: Record<string, ConnectionCount>; connections: Record<string, ConnectionCount>}>}
type Usage = Awaited<ReturnType<Sessions['usage']>>;
interface UsageOptions {principal: Principal; workos: Workos; integrations?: Pick<Integrations, 'list'> | null; search?: Sessions | null; connectors?: Connectors | null; onboarding?: ReturnType<typeof createOnboardingStatus> | null; tab?: string; days?: number; log?: Log}
interface IndexReport {sessionEvents: number | null; connectorDocuments: number | null; connectorKinds: Record<string, number>; sources: Array<{name: string; count: number}>; searchMs: number | null; probes: number[]}
// Shared usage report: integrations, WorkOS members, and session activity.
// Activity and setup receipts are scoped to the selected organization.
const PROBE = 'the';
const empty = (): Usage => ({events: 0, lifetimeEvents: 0, sessions: 0, subagentSessions: 0, messages: 0, toolCalls: 0, machines: 0, opencrawlCalls: 0, tools: [], harnesses: [], origins: [], firstAt: null, lastAt: null, daily: [], people: []});
const missing = (error: unknown) => errorInfo(error).status === 404 || errorInfo(error).type === 'index_not_found_exception';
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * principal must already be verified for its tenant. Every source is optional: a missing
 * service shows as unavailable rather than failing the page.
 */
export async function usageReport({principal, workos, integrations, search, connectors, onboarding, tab, days = 30, log = () => {}}: UsageOptions) {
  const team = principal.tenantId.startsWith('org_');
  const memberScope = (userId: string) => ({tenantId: principal.tenantId, userId});
  function soft<T>(name: string, operation: () => Promise<T>): Promise<T | null>;
  function soft<T, F>(name: string, operation: () => Promise<T>, fallback: F): Promise<T | F | null>;
  function soft<T, F>(name: string, operation: () => Promise<T>, fallback: F | null = null): Promise<T | F | null> {
    return Promise.resolve().then(operation).catch(error => {
      if (missing(error)) return fallback;
      log('usage.source.failed', {source: name, message: errorInfo(error).message});
      return null;
    });
  }


  const emptyCounts: Awaited<ReturnType<Connectors['count']>> = {total:0,kinds:{},providers:{},connections:{}};
  // These reports are independent. Navigation waits for the slowest read, not their sum.
  const [organization, users, cards, agents, probeResults, counted] = await Promise.all([
    team ? soft('organization', () => workos.organizations.getOrganization(principal.tenantId)) : null,
    team ? soft('members', async () => {
      const memberships = await workos.userManagement.listOrganizationMemberships({organizationId: principal.tenantId, statuses: ['active'], limit: 100});
      const rows = memberships.autoPagination ? await memberships.autoPagination() : memberships.data;
      const ids = [...new Set(rows.filter(m => m.organizationId === principal.tenantId && m.status === 'active').map(m => m.userId))];
      return Promise.all(ids.map(id => workos.userManagement.getUser(id)));
    }) : soft('members', async () => [await workos.userManagement.getUser(principal.userId)]),
    integrations ? soft('integrations', () => integrations.list(principal)) : null,
    search ? soft('sessions', () => search.usage(principal, {team: true, days}), empty()) : null,
    Promise.all(Array.from({length:search ? 3 : 0}, () => soft('probe', () => search!.search(principal, {query:PROBE,limit:10,raw:true})))),
    connectors ? soft('connectors', () => connectors.count(principal), emptyCounts) : null,
  ]);
  const members = users || [];
  const probes = probeResults.flatMap(result => result && 'took' in result && typeof result.took === 'number' && Number.isFinite(result.took) ? [result.took] : []);
  const connectionCounts = counted?.connections || null;
  const providerNames = new Map((cards || []).map(card => [card.provider, card.name]));
  const index: IndexReport | null = search || connectors ? {
    sessionEvents:agents?.lifetimeEvents ?? null,connectorDocuments:counted?.total ?? null,connectorKinds:counted?.kinds || {},
    sources:Object.entries(counted?.providers || {}).map(([provider,count])=>({name:providerNames.get(provider)||provider,count:count.total})),
    searchMs:probes.length?median(probes):null,probes,
  } : null;

  const sources = (cards || []).filter(c => c.integrationId).map(c => ({
    name: c.name, icon: `/assets/integrations/${c.provider}.svg`, account: c.account, state: c.state, records: c.synced || 0,
    units: c.units, rows: c.rows, lastSyncedAt: c.lastSyncedAt || null, connectedAt: c.connectedAt || null,
    connectedBy: (owner => owner ? displayName(owner) : c.connectedBy)(members.find(u => u.id === c.connectedById)),
    connectedById: c.connectedById,
    ...indexedSourceInventory(connectionCounts?.[c.integrationId!]),
  }));

  const setup = await Promise.all(members.map(async user => {
    if (!onboarding) return {};
    const receipt: Partial<OnboardingReceipts> | null = await soft('onboarding', () => onboarding.read(memberScope(user.id)), {});
    const {cli = null, mcp = null, session = null} = receipt || {};
    return {cli, mcp, session, client: mcp?.client || null};
  }));

  const activity = new Map((agents?.people || []).map(p => [p.userId, p]));
  const report = {
    tab, team, days, generatedAt: new Date().toISOString(), integrationsUrl: '/integrations',
    workspace: organization?.name || (team ? null : 'Personal workspace'),
    ingestion: cards ? {sources, index} : null, agents,
    members: members.map((user, i) => {
      const a: Partial<Usage['people'][number]> = activity.get(user.id) || {};
      return {name: displayName(user, null), email: user.email, you: user.id === principal.userId,
        sources: sources.filter(s => s.connectedById === user.id).length,
        sessions: a.sessions || 0, subagentSessions: a.subagentSessions || 0, messages: a.messages || 0, toolCalls: a.toolCalls || 0, weekEvents: a.weekEvents || 0, lastAt: a.lastAt || null, setup: setup[i]};
    }),
  };
  return report;
}

function displayName(user: HostedUser, fallback: string | null = user.email) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || fallback;
}
