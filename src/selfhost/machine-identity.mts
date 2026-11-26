import {createHash} from 'node:crypto';
import type {Principal} from '../identity/types.mjs';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Only the self-host operator can configure verifiers. The service name persists across key rotation. */
export function machineIdentities(tenantId: string, configuration = '') {
  const byDigest = new Map<string, Principal>();
  const byName = new Map<string, Principal>();
  const entries = configuration ? configuration.split(',') : [];
  if (entries.length > 32) throw Error('OPENCRAWL_MACHINE_KEYS supports up to 32 active keys');
  for (const entry of entries) {
    const match = /^([a-z][a-z0-9-]{0,47}):([a-f0-9]{64})$/.exec(entry.trim());
    if (!match || byDigest.has(match[2]!)) throw Error('Invalid or duplicate OPENCRAWL_MACHINE_KEYS verifier');
    const name = match[1]!;
    const principal: Principal = byName.get(name) ?? {
      tenantId, userId: 'workload_machine_' + digest(JSON.stringify([tenantId, name])),
      name, owner: {kind: 'shared', provider: 'machine', name},
    };
    byName.set(name, principal);
    byDigest.set(match[2]!, principal);
  }
  // The first configured service can complete the operator's shared onboarding.
  const first = byName.values().next().value;
  const sharedInstallations = first ? [{id: first.userId, tenantId, userId: first.userId, name: first.name!}] : [];
  return {
    sharedInstallations,
    identify(token: string) {
      const principal = /^oca1_[a-f0-9]{64}$/.test(token) ? byDigest.get(digest(token)) : undefined;
      if (!principal) return {status: 401 as const};
      return {status: 200 as const, user: {id: principal.userId, email: null}, principal};
    },
    authorize(principal: Principal) {
      if (principal.owner?.provider !== 'machine' || byName.get(principal.owner.name) !== principal)
        throw Object.assign(new Error('Machine identity required'), {status: 403});
      return principal;
    },
  };
}
