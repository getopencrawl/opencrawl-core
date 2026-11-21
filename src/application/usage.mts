import {errorInfo} from '../errors.mjs';
import type {Principal, IdentityDirectory, HostedUser} from '../identity/types.mjs';
import type {Log} from '../integrations/ports.mjs';
import type {Integrations} from '../integrations/service.mjs';
import type {createSessionSearch} from '../sessions/search.mjs';
import type {createOnboardingStatus, OnboardingReceipts} from '../onboarding-status.mjs';
import {indexedSourceInventory} from './usage-inventory.mjs';
import type {ValueReports} from './value-report.mjs';
import type {SessionOverlap, UsageSource, UsageHighlights, UsageDetails, UsageReport} from './reports.mjs';
import {consoleFailure} from './console.mjs';
import {dailyOverlap} from '../sessions/overlap.mjs';
type Sessions = Pick<ReturnType<typeof createSessionSearch>, 'usage' | 'overlap'> & Partial<Pick<ReturnType<typeof createSessionSearch>, 'tokenTotals' | 'tokenSessions'>>;
import {rangeDays, tokenSessionsRequest, type UsageRange, type TokenUsage, type TokenSessionPage, type DailyCount, type TokenSession} from './usage-range.mjs';
import type {SearchActivityRow} from './search-activity.mjs';
/**
 * A deployment's usage meter: the session tokens it charges for, dated by when each
 * event happened. Without one, Usage reads captured tokens from the index.
 */
export interface TokenLedger {
  usage(principal: Principal, range: UsageRange, now: number): Promise<{total: number; daily: DailyCount[]}>;
  sessions(principal: Principal, range: UsageRange, offset: number): Promise<{rows: TokenSession[]; more: boolean}>;
}
type Visible = (principal: Principal, rows: SearchActivityRow[]) => Promise<SearchActivityRow[]>;
interface ConnectionCount {total: number; kinds: Record<string, number>}
interface Connectors {count(principal: Principal): Promise<ConnectionCount & {providers: Record<string, ConnectionCount>; connections: Record<string, ConnectionCount>}>}
type Usage = Awaited<ReturnType<Sessions['usage']>>;
export interface UsageOptions {principal: Principal; directory: IdentityDirectory; integrations?: Pick<Integrations, 'list'> | null; search?: Sessions | null; connectors?: Connectors | null; onboarding?: ReturnType<typeof createOnboardingStatus> | null; values?: ValueReports | null; captured?: ((principal: Principal) => Promise<{tokens: number; since: string}>) | null; tab?: string; days?: number | null; log?: Log; tokens?: TokenLedger | null; visible?: Visible | null}
interface IndexReport {sessionEvents: number | null; connectorDocuments: number | null; connectorKinds: Record<string, number>; sources: Array<{name: string; count: number}>; searchMs: number | null; probes: number[]}
// Shared usage report: integrations, WorkOS members, and session activity.
// Activity and setup receipts are scoped to the selected organization.
const empty = (): Usage => ({events: 0, lifetimeEvents: 0, sessions: 0, subagentSessions: 0, messages: 0, toolCalls: 0, machines: 0, opencrawlCalls: 0, tools: [], harnesses: [], origins: [], firstAt: null, lastAt: null, daily: [], people: []});
const missing = (error: unknown) => errorInfo(error).type === 'index_not_found_exception';

/**
 * principal must already be verified for its tenant. Independent failed reads
 * are explicit so clients can retain only the affected measurement.
 */
export function usageReport(options: UsageOptions & {part: 'highlights'}): Promise<UsageHighlights>;
export function usageReport(options: UsageOptions & {part: 'details'}): Promise<UsageDetails>;
export function usageReport(options: UsageOptions): Promise<UsageReport>;
export async function usageReport({principal, directory, integrations, search, connectors, onboarding, captured, tab, days = 30, log = () => {}, part}: UsageOptions & {part?: 'highlights' | 'details'}): Promise<UsageHighlights | UsageDetails | UsageReport> {
  const team = principal.tenantId.startsWith('org_');
  const memberScope = (userId: string) => ({tenantId: principal.tenantId, userId});
  const failedSources = new Set<UsageSource>();
  function soft<T>(name: UsageSource, operation: () => Promise<T>): Promise<T | null>;
  function soft<T, F>(name: UsageSource, operation: () => Promise<T>, fallback: F): Promise<T | F | null>;
  function soft<T, F>(name: UsageSource, operation: () => Promise<T>, fallback: F | null = null): Promise<T | F | null> {
    return Promise.resolve().then(operation).catch(error => {
      if (missing(error)) return fallback;
      const {status} = errorInfo(error);
      if (status === 401 || status === 402 || status === 403) throw consoleFailure(status, 'Workspace access changed. Sign in again.');
      failedSources.add(name);
      log('usage.source.failed', {source: name, message: errorInfo(error).message});
      return null;
    });
  }

  async function highlights() {
    const [organization, capture] = await Promise.all([
      team ? soft('organization', () => directory.organizations.getOrganization(principal.tenantId)) : null,
      team && captured ? soft('capture', () => captured(principal)) : null,
    ]);
    return {workspace: organization?.name || (team ? null : 'Personal workspace'), value: null,
      capture: capture ? {tokens: capture.tokens, since: capture.since} : null};
  }

  async function details() {
    const userRead = team ? soft('members', async () => {
      const memberships = await directory.userManagement.listOrganizationMemberships({organizationId: principal.tenantId, statuses: ['active'], limit: 100});
      const rows = memberships.autoPagination ? await memberships.autoPagination() : memberships.data;
      const ids = [...new Set(rows.filter(m => m.organizationId === principal.tenantId && m.status === 'active').map(m => m.userId))];
      return Promise.all(ids.map(id => directory.userManagement.getUser(id)));
    }) : soft('members', async () => [await directory.userManagement.getUser(principal.userId)]);
    const setupRead = userRead.then(users => {
      const members = users ?? [];
      return Promise.all(members.map(async user => {
        if (!onboarding) return {};
        const receipt: Partial<OnboardingReceipts> | null = await soft('onboarding', () => onboarding.read(memberScope(user.id)).catch(error => {
          if (errorInfo(error).status === 404) return {};
          throw error;
        }), {});
        const {cli = null, mcp = null, session = null} = receipt || {};
        return {cli, mcp, session, client: mcp?.client || null, ...(receipt?.shared ? {shared: receipt.shared} : {})};
      }));
    });
    const emptyCounts: Awaited<ReturnType<Connectors['count']>> = {total:0,kinds:{},providers:{},connections:{}};
    const [users, setup, cards, sessions, counted] = await Promise.all([
      userRead, setupRead,
      integrations ? soft('integrations', () => integrations.list(principal)) : null,
      (async () => {
        if (!search) return {agents: null, overlap: null};
        const now = Date.now();
        const [agents, overlap] = await Promise.all([
          soft('sessions', async () => search.usage(principal, {team: true, days, now, members: (await userRead) ?? []}), empty()),
          soft('overlap', () => search.overlap(principal, {days: days ?? 30, now}), {timeZone: 'UTC', measuredAt: new Date(now).toISOString(), sessions: 0, daily: dailyOverlap([], days ?? 30, now)} satisfies SessionOverlap),
        ]);
        return {agents, overlap};
      })(),
      connectors ? soft('connectors', () => connectors.count(principal), emptyCounts) : null,
    ]);
    const {agents} = sessions;
    const members = users ?? [];
    const connectionCounts = counted?.connections || null;
    const providerNames = new Map((cards || []).map(card => [card.provider, card.name]));
    const index: IndexReport | null = search || connectors ? {
      sessionEvents:agents?.lifetimeEvents ?? null,connectorDocuments:counted?.total ?? null,connectorKinds:counted?.kinds || {},
      sources:Object.entries(counted?.providers || {}).map(([provider,count])=>({name:providerNames.get(provider)||provider,count:count.total})),
      searchMs:null,probes:[],
    } : null;

    const sources = (cards || []).filter(c => c.integrationId).map(c => ({
      name: c.name, icon: `/assets/integrations/${c.provider}.svg`, account: c.account, state: c.state, records: c.synced ?? null,
      units: c.units, rows: c.rows, lastSyncedAt: c.lastSyncedAt || null, connectedAt: c.connectedAt || null,
      connectedBy: (owner => owner ? displayName(owner) : c.connectedBy)(members.find(u => u.id === c.connectedById)),
      connectedById: c.connectedById,
      ...indexedSourceInventory(connectionCounts?.[c.integrationId!]),
    }));

    const activity = new Map((agents?.people || []).map(p => [p.userId, p]));
    return {
      ingestion: cards ? {sources, index} : null, ...sessions,
      members: members.map((user, i) => {
        const a: Partial<Usage['people'][number]> = activity.get(user.id) || {};
        return {userId: user.id, name: displayName(user, null), email: user.email, you: user.id === principal.userId,
          sources: sources.filter(s => s.connectedById === user.id).length,
          sessions: a.sessions || 0, subagentSessions: a.subagentSessions || 0, messages: a.messages || 0, toolCalls: a.toolCalls || 0, weekEvents: a.weekEvents || 0, lastAt: a.lastAt || null, setup: setup[i]};
      }),
    };
  }

  // Capture measurement time and failed sources after the requested reads settle.
  const metadata = () => ({tab, team, days, generatedAt: new Date().toISOString(), failedSources: [...failedSources].sort(), integrationsUrl: '/integrations'});
  if (part === 'highlights') return {...await highlights(), ...metadata()};
  if (part === 'details') return {...await details(), ...metadata()};
  const [summary, activity] = await Promise.all([highlights(), details()]);
  return {...summary, ...activity, ...metadata()};
}

function displayName(user: HostedUser, fallback: string | null = user.email) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || fallback;
}

/** Session tokens for Usage: the deployment's meter when it has one, else captured tokens in the index. */
export async function tokenUsage({principal, search, tokens}: UsageOptions, range: UsageRange, now = Date.now()): Promise<TokenUsage> {
  if (tokens) return {source: 'meter', range, ...await tokens.usage(principal, range, now)};
  if (!search?.tokenTotals) throw consoleFailure(503, 'Token usage is unavailable on this deployment.');
  const {total, daily} = await search.tokenTotals(principal, {team: principal.tenantId.startsWith('org_'), days: rangeDays(range), now});
  return {source: 'index', range, total, daily};
}

/** One page of sessions by recent activity. Rows the viewer may not read are left out; totals still count them. */
export async function tokenSessionPage({principal, search, tokens, visible}: UsageOptions, input: unknown, now = Date.now()): Promise<TokenSessionPage> {
  const {range, offset = 0} = tokenSessionsRequest.parse(input);
  const page = tokens ? await tokens.sessions(principal, range, offset)
    : search?.tokenSessions ? await search.tokenSessions(principal, {team: principal.tenantId.startsWith('org_'), days: rangeDays(range), now, offset})
    : (() => {throw consoleFailure(503, 'Token usage is unavailable on this deployment.');})();
  if (page.rows.length > 25) throw new Error('Oversized token session page');
  if (!visible) throw consoleFailure(503, 'Session visibility is unavailable.');
  const asRows = page.rows.map((row, i): SearchActivityRow => ({id: String(i), at: row.lastAt ?? '', userId: row.userId, operation: '', queries: [], harness: row.harness, sessionId: row.sessionId,
    messageId: null, message: null, returned: null, outcome: 'unknown', delivered: false}));
  const allowed = new Set((await visible(principal, asRows)).map(row => row.id));
  return {rows: page.rows.filter((_, i) => allowed.has(String(i))), next: page.more ? offset + 25 : null};
}

/** Bind every console read path to the same trusted deployment adapters. */
export function usageServices(options: (principal: Principal) => UsageOptions) {
  return {
    usage: (principal: Principal) => usageReport(options(principal)),
    usageParts: {
      highlights: (principal: Principal) => usageReport({...options(principal), part: 'highlights'}),
      details: (principal: Principal, range: UsageRange = '30d') => usageReport({...options(principal), days: rangeDays(range), part: 'details'}),
    },
    usageTokens: {
      usage: (principal: Principal, range: UsageRange) => tokenUsage(options(principal), range),
      sessions: (principal: Principal, input: unknown) => tokenSessionPage(options(principal), input),
    },
  };
}
export {rangeDays, type UsageRange, type TokenUsage, type TokenSession} from './usage-range.mjs';
