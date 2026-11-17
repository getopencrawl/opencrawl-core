import type {Principal} from '../identity/types.mjs';
import type {createOnboardingStatus} from '../onboarding-status.mjs';
type ObservedOnboarding = Pick<ReturnType<typeof createOnboardingStatus>, 'cli' | 'session'>;
type Batch = Parameters<ObservedOnboarding['session']>[1];
interface ObservationError {event: string; kind: 'cli' | 'session'; reason: 'timeout' | 'error'}
/** Optional setup receipts must not change authenticated or committed results. */
export function createOnboardingObserver(onboarding: ObservedOnboarding | null, {
  timeoutMs = 1000, onError = event => console.error(JSON.stringify(event)),
}: {timeoutMs?: number; onError?: (event: ObservationError) => unknown} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('Invalid onboarding observation timeout');
  async function record(kind: 'cli' | 'session', invoke: () => unknown) {
    if (!onboarding) return;
    let deadline: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      // This bounds waiting, not the underlying write. Promise.race also handles
      // a late rejection after the deadline; no authorization runs inside it.
      await Promise.race([
        Promise.resolve().then(invoke),
        new Promise((_, reject) => {
          deadline = setTimeout(() => { timedOut = true; reject(new Error('Onboarding observation timeout')); }, timeoutMs);
        }),
      ]);
    } catch {
      // Only fixed event fields enter logs, never identities or storage errors.
      // A throwing, rejecting or stalled sink cannot conceal the result either.
      try { Promise.resolve(onError({event: 'onboarding.observation_failed', kind, reason: timedOut ? 'timeout' : 'error'})).catch(() => {}); } catch {}
    } finally { clearTimeout(deadline); }
  }
  return {
    cli: (principal: Principal) => record('cli', () => onboarding!.cli(principal)),
    session: (principal: Principal, batch: Batch) => record('session', () => onboarding!.session(principal, batch)),
  };
}
