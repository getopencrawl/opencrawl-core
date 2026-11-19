import {isSessionHarness, type Principal} from '../sessions/types.mjs';
import {encodeSessionReference, parseSessionReference} from '../sessions/session-reference.mjs';
import type {createRecentSessions} from '../sessions/recent.mjs';
import type {BoardRepository} from '../state/board.mjs';
import type {Participant, BoardMessage} from './types.mjs';
import {boardIdentity} from './identity.mjs';

/** Preserve exact coordinates if a later poll provides only the native session ID. */
export function bindPresenceSession(p: Participant, principal: Principal, session?: string, installation?: string, harness = p.harness) {
  if (!session) return false;
  if (![principal.tenantId, principal.userId, session, installation].every(part => part === undefined || /^[A-Za-z0-9_.:-]{1,200}$/.test(part))) return false;
  let previous;
  try { previous = p.captureRef ? parseSessionReference(p.captureRef, true) : undefined; }
  catch { /* Rebuild a stale reference from the authenticated registration. */ }
  const same = previous && previous[0] === principal.tenantId && previous[1] === principal.userId && previous[4] === session ? previous : undefined;
  const ref = encodeSessionReference([principal.tenantId, principal.userId,
    isSessionHarness(harness) ? harness : same?.[2] ?? null,
    installation ?? same?.[3] ?? null, session]);
  if (p.captureRef === ref) return false;
  p.captureRef = ref;
  return true;
}

/** Bytes still available to opening prompts on one page, shared by its messages in page order. */
export interface PromptBudget { remaining: number }
const promptHeading = '\n\nOpening user prompt\n';
const truncated = '…';
/** Growth of a serialized JSON string field when `value` is appended to it. */
const encodedBytes = (value: string) => Buffer.byteLength(JSON.stringify(value)) - 2;

/** Pages are admitted before capture work runs, so prompts may only spend the
 * bytes the admitted views left under that page's budget. */
export function promptBudget(views: readonly unknown[], bytes: number): PromptBudget {
  let used = 0;
  for (const view of views) used += Buffer.byteLength(JSON.stringify(view));
  return {remaining: Math.max(0, bytes - used)};
}

/** The suffix that fits the budget, shortened on a code point boundary and
 * marked when cut. Without a budget the prompt is returned whole. */
export function fitOpeningPrompt(prompt: string, budget?: PromptBudget) {
  if (!budget) return promptHeading + prompt;
  const fixed = encodedBytes(promptHeading), whole = encodedBytes(prompt);
  if (fixed + whole <= budget.remaining) {
    budget.remaining -= fixed + whole;
    return promptHeading + prompt;
  }
  const room = budget.remaining - fixed - encodedBytes(truncated);
  let kept = '', used = 0;
  for (const point of prompt) {
    const size = encodedBytes(point);
    if (used + size > room) break;
    kept += point; used += size;
  }
  if (!kept) return undefined;
  budget.remaining -= fixed + used + encodedBytes(truncated);
  return promptHeading + kept + truncated;
}

export function presencePreviews(repository: BoardRepository, recent: ReturnType<typeof createRecentSessions> | undefined, timeoutMs: number) {
  return (principal: Principal, key: string) => {
    const pending = new Map<string, {agent: string}>();
    // Registration order is page order, so a shared budget is spent deterministically.
    const applies: Array<{ref: string; apply: (prompt: string) => void}> = [];
    function add(agent: string, ref: string | undefined, apply: (prompt: string) => void) {
      if (!ref || !recent) return;
      try {
        const [tenant, owner, , , session] = parseSessionReference(ref, true);
        if (tenant !== principal.tenantId || boardIdentity(owner, session) !== agent) return;
      } catch { return; }
      if (!pending.has(ref)) pending.set(ref, {agent});
      applies.push({ref, apply});
    }
    return {
      peer(source: {agent: string; name: string; task: string; captureRef?: string}) {
        const peer: {name: string; task: string; firstUserPrompt?: string} = {name: source.name, task: source.task};
        add(source.agent, source.captureRef, prompt => { peer.firstUserPrompt = prompt; });
        return peer;
      },
      /** Pass the page's budget for any paged response; the appended prompt never exceeds it. */
      message<T extends {text?: string; preview?: string}>(view: T, source: Pick<BoardMessage, 'agent' | 'captureRef' | 'onlineAudience'>, budget?: PromptBudget) {
        if (source.onlineAudience && typeof view.text === 'string') {
          add(source.agent, source.captureRef, prompt => { const suffix = fitOpeningPrompt(prompt, budget); if (suffix !== undefined) view.text += suffix; });
        } else if (source.onlineAudience && typeof view.preview === 'string') {
          add(source.agent, source.captureRef, prompt => { const suffix = fitOpeningPrompt(prompt, budget); if (suffix !== undefined) view.preview += suffix; });
        }
        return view;
      },
      async finish<T>(operation: Promise<T>) {
        const result = await operation;
        if (!recent || !pending.size) return result;
        const agents = [...new Set(Array.from(pending.values(), item => item.agent))];
        const blockedAgents = async () => new Set(await repository.read(key, tx => tx.blockedPublications(agents)));
        const entries = pending.entries(), found = new Map<string, string>();
        const controller = new AbortController();
        // The board transaction has committed. Bound optional capture work for the
        // entire response, including backends that do not honor cancellation.
        async function load() {
          const blocked = await blockedAgents();
          async function worker() {
            for (const [ref, item] of entries) {
              if (controller.signal.aborted) return;
              if (blocked.has(item.agent)) continue;
              try {
                const [session] = await recent!.read(principal, {id: ref, field: 'firstUserMessage', openingPrompt: true, signal: controller.signal});
                const prompt = session?.firstUserMessage?.text;
                if (prompt && !controller.signal.aborted) found.set(ref, prompt);
              } catch { /* One unavailable capture must not suppress other introductions. */ }
            }
          }
          await Promise.all(Array.from({length: Math.min(4, pending.size)}, worker));
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([load(), new Promise<void>(resolve => {
            timer = setTimeout(() => { controller.abort(); resolve(); }, timeoutMs);
          })]);
          if (found.size) {
            const hidden = await blockedAgents();
            for (const {ref, apply} of applies) {
              const prompt = found.get(ref);
              if (prompt !== undefined && !hidden.has(pending.get(ref)!.agent)) apply(prompt);
            }
          }
        } catch { /* If privacy checks are unavailable, return only the task. */ }
        finally { clearTimeout(timer); }
        return result;
      },
    };
  };
}
export type PreviewFactory = ReturnType<typeof presencePreviews>;
