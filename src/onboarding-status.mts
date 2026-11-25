import type {Principal, ObjectStore, SessionBatch} from './sessions/types.mjs';
import {objectOnboardingReceipts} from './onboarding-object-receipts.mjs';
import {onboardingKinds,type OnboardingReceipt,type OnboardingKind,type OnboardingRepository} from './onboarding-receipts.mjs';
export type {OnboardingReceipt, OnboardingKind, OnboardingRepository} from './onboarding-receipts.mjs';
export type OnboardingReceipts = Record<OnboardingKind, OnboardingReceipt | null> & {shared?: OnboardingReceipt & {id: string; name: string; owner: 'shared'}};
export interface SharedInstallation {id: string; tenantId: string; userId: string; name: string}
import {deriveOnboarding} from './onboarding-state.mjs';
import {sessionScope} from './sessions/event-identity.mjs';
import {isSessionHarness} from './sessions/types.mjs';

/** Durable per-user setup milestones, not a claim that credentials remain valid forever. */
type ReceiptSource = {repository:OnboardingRepository;store?:never;prefix?:never} | {store:Pick<ObjectStore,'put'|'get'>;prefix?:string;repository?:never};
export function createOnboardingStatus(options: ReceiptSource & {now?: () => Date; sharedInstallations?: (principal: Principal) => readonly SharedInstallation[] | Promise<readonly SharedInstallation[]>; onSharedReady?: (principal: Principal) => Promise<void>}) {
  const {now = () => new Date(), sharedInstallations = () => [], onSharedReady} = options;
  const repository = options.repository ?? objectOnboardingReceipts(options.store, options.prefix ?? 'capture-v1');
  async function record(principal: Principal, kind: OnboardingKind, details: Omit<Partial<OnboardingReceipt>, 'observedAt'> = {}) {
    const owner = sessionScope(principal);
    const value = await repository.write(owner, kind, {observedAt: now().toISOString(), ...details});
    if (onSharedReady && principal.owner?.kind === 'shared' && ['cli','mcpTest','session'].includes(kind)) {
      const receipts = await repository.read(owner, ['cli','mcpTest','session']);
      if (deriveOnboarding(receipts).complete) await onSharedReady(principal);
    }
    return value;
  }
  return {
    cli: (principal: Principal) => record(principal, 'cli'),
    async mcp(principal: Principal, clientInfo?: {name?: unknown}) {
      return record(principal, 'mcp', clientInfo ? {client:mcpClientName(clientInfo.name)} : {});
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
      const scope = sessionScope(principal);
      if (principal.captureAccess === 'write') throw Object.assign(new Error('Capture credentials cannot read onboarding status'), {status: 403});
      const values = await repository.read(scope, onboardingKinds);
      const status: OnboardingReceipts = {cli:null, mcp:null, mcpTest:null, session:null, history:null, completed:null, ...values};
      for (const installation of (await sharedInstallations(principal)).filter(row => row.tenantId === principal.tenantId)) {
        const receipts = await repository.read(sessionScope(installation), ['cli','mcpTest','session']);
        if (deriveOnboarding(receipts).complete) {
          status.shared = {id: installation.id, name: installation.name, owner: 'shared', observedAt: Object.values(receipts).map(receipt => receipt.observedAt).sort().at(-1)!};
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
