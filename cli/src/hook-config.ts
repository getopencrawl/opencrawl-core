import {isDeepStrictEqual} from 'node:util';

type Hook = Record<string, unknown>;
type HookEvents = Record<string, unknown[]>;
type Owned = (entry: unknown) => boolean;
const record = (value: unknown): value is Hook => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Keep each owned hook's position stable: native trust can include its index.
 * Only missing hooks append; obsolete and duplicate owned hooks are removed. */
export function reconcileHookEntries(current: HookEvents, desired: Record<string, Hook>, owned: Owned): HookEvents {
  const next = {...current};
  for (const event of new Set([...Object.keys(current), ...Object.keys(desired)])) {
    const entries = current[event] ?? [], wanted = Object.hasOwn(desired, event) ? desired[event] : undefined;
    let placed = false;
    const updated = entries.flatMap(entry => {
      if (!owned(entry)) return [entry];
      if (!wanted || placed) return [];
      placed = true;
      return [isDeepStrictEqual(entry, wanted) ? entry : wanted];
    });
    if (wanted && !placed) updated.push(wanted);
    if (updated.length || !entries.length && event in current) next[event] = updated;
    else delete next[event];
  }
  return next;
}

/** Group metadata and unrelated hooks stay in place. An unconditional installed
 * hook cannot be satisfied by an entry inside a conditional matcher group. */
export function reconcileHookGroups(current: HookEvents, desired: Record<string, Hook>, owned: Owned, matchers: Record<string,string> = {}): HookEvents {
  const next = {...current};
  for (const event of new Set([...Object.keys(current), ...Object.keys(desired)])) {
    const groups = current[event] ?? [], wanted = Object.hasOwn(desired, event) ? desired[event] : undefined, matcher = matchers[event];
    let placed = false;
    const updated = groups.flatMap(group => {
      if (!record(group) || !Array.isArray(group.hooks)) return [group];
      const matches = matcher ? group.matcher === matcher : group.matcher === undefined || group.matcher === '';
      // An owned conditional group can update its matcher in place. Never change
      // the condition applying to unrelated hooks in a mixed native group.
      if (matcher && wanted && !placed && group.hooks.length && group.hooks.every(owned)) {
        placed = true;
        return [{...group, matcher, hooks: [wanted]}];
      }
      const hooks = group.hooks.flatMap(entry => {
        if (!owned(entry)) return [entry];
        if (!wanted || placed || !matches) return [];
        placed = true;
        return [isDeepStrictEqual(entry, wanted) ? entry : wanted];
      });
      if (!hooks.length && group.hooks.length) return [];
      return [isDeepStrictEqual(group.hooks, hooks) ? group : {...group, hooks}];
    });
    if (wanted && !placed) updated.push({...matcher ? {matcher} : {}, hooks: [wanted]});
    if (updated.length || !groups.length && event in current) next[event] = updated;
    else delete next[event];
  }
  return next;
}
