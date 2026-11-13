import type {Principal, ObjectStore, SessionBatch} from './sessions/types.mjs';
export interface OnboardingReceipt {observedAt: string; client?: string | null; harness?: string; state?: string}
export type OnboardingKind = 'cli' | 'mcp' | 'mcpTest' | 'session' | 'history' | 'completed';
export type OnboardingReceipts = Record<OnboardingKind, OnboardingReceipt | null> & {shared?: OnboardingReceipt & {id: string; name: string; owner: 'shared'}};
export interface SharedInstallation {id: string; tenantId: string; userId: string; name: string}
import {deriveOnboarding} from './onboarding-state.mjs';
import {sessionScope} from './sessions/ingest.mjs';
import {isSessionHarness} from './sessions/types.mjs';

/** Durable per-user setup milestones, not a claim that credentials remain valid forever. */
export function createOnboardingStatus({store, prefix = 'capture-v1', now = () => new Date(), sharedInstallations = () => []}: {store: Pick<ObjectStore, 'put' | 'get'>; prefix?: string; now?: () => Date; sharedInstallations?: () => readonly SharedInstallation[]}) {
  if (!store?.put || !store?.get) throw new Error('Onboarding requires durable storage');
  const key = (principal: Principal, kind: OnboardingKind) => `${prefix}/${sessionScope(principal)}/onboarding/${kind}.json`;
  async function record(principal: Principal, kind: OnboardingKind, details: Omit<Partial<OnboardingReceipt>, 'observedAt'> = {}) {
    const value = {observedAt: now().toISOString(), ...details};
    await store.put(key(principal, kind), Buffer.from(JSON.stringify(value)), 'application/json');
    return value;
  }
  return {
    cli: (principal: Principal) => record(principal, 'cli'),
    async mcp(principal: Principal, clientInfo?: {name?: unknown}) {
      const previous = !clientInfo ? await store.get(key(principal, 'mcp')) : null;
      const client = clientInfo ? mcpClientName(clientInfo.name) : previous ? JSON.parse(previous.toString()).client : null;
      return record(principal, 'mcp', {client});
    },
    mcpTest: (principal: Principal) => record(principal, 'mcpTest'),
    session: (principal: Principal, batch: SessionBatch) => {
      if (!isSessionHarness(batch.harness)) throw new Error('Unknown session harness');
      // Some Grok Bot runtimes emit only tool hooks; a recorded tool call is live activity too.
      const recorded = batch.harness === 'grok-bot' ? ['message', 'tool_call'] : ['message'];
      if (!batch.events?.some(event => recorded.includes(event.kind))) return;
      if (batch.captureMode === 'history') return record(principal, 'history', {state:'received', harness:batch.harness});
      return record(principal, 'session', {harness: batch.harness});
    },
    async complete(principal: Principal) {
      const status = await this.read(principal);
      if (!deriveOnboarding(status).complete) throw Object.assign(new Error('Complete agent setup first'), {status:409});
      if (status.shared) return status.shared;
      return status.completed || record(principal, 'completed');
    },
    async read(principal: Principal): Promise<OnboardingReceipts> {
      sessionScope(principal);
      if (principal.captureAccess === 'write') throw Object.assign(new Error('Capture credentials cannot read onboarding status'), {status: 403});
      const values = await Promise.all((['cli','mcp','mcpTest','session','history','completed'] as const).map(async kind => {
        const bytes = await store.get(key(principal, kind));
        return bytes ? JSON.parse(bytes.toString()) : null;
      }));
      const status: OnboardingReceipts = {cli: values[0], mcp: values[1], mcpTest: values[2], session: values[3], history: values[4], completed: values[5]};
      for (const installation of sharedInstallations().filter(row => row.tenantId === principal.tenantId)) {
        const receipts = await Promise.all((['cli', 'mcpTest', 'session'] as const).map(async kind => {
          const bytes = await store.get(key(installation, kind));
          return bytes ? JSON.parse(bytes.toString()) as OnboardingReceipt : null;
        }));
        if (deriveOnboarding({cli: receipts[0], mcpTest: receipts[1], session: receipts[2]}).complete) {
          status.shared = {id: installation.id, name: installation.name, owner: 'shared', observedAt: receipts.map(receipt => receipt!.observedAt).sort().at(-1)!};
          break;
        }
      }
      return status;
    },
  };
}

// Self-reported display metadata. Unknown values never become arbitrary UI labels.
export function mcpClientName(name: unknown) {
  if (typeof name !== 'string' || name.length > 200) return null;
  const value = name.toLowerCase().replace(/[ _-]/g, '');
  if (['claude','claudeai','claudedesktop','claudecode'].includes(value)) return 'Claude';
  if (['chatgpt','openai','chatgptdeveloper'].includes(value)) return 'ChatGPT';
  if (['codex','codexcli','openaicodex'].includes(value)) return 'Codex';
  if (value === 'cursor') return 'Cursor';
  return null;
}
