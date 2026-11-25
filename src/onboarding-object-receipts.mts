import type {ObjectStore} from './sessions/types.mjs';
import {onboardingKinds,validateReceiptScope,validateReceipt,type OnboardingKind,type OnboardingRepository,type ReceiptMap} from './onboarding-receipts.mjs';

export function onboardingReceiptKey(prefix:string, scope:string, kind:OnboardingKind) {
  validateReceiptScope(scope);
  if(!onboardingKinds.includes(kind))throw Error('Invalid onboarding milestone');
  return `${prefix}/${scope}/onboarding/${kind}.json`;
}

export function objectOnboardingReceipts(store: Pick<ObjectStore, 'get'|'put'>, prefix: string): OnboardingRepository {
  if (!store?.put || !store?.get) throw Error('Onboarding requires durable storage');
  async function read(scope: string, kinds: readonly OnboardingKind[]) {
    validateReceiptScope(scope);
    const result: ReceiptMap = {};
    await Promise.all(kinds.map(async kind => {
      const bytes = await store.get(onboardingReceiptKey(prefix,scope, kind), {maxBytes: 64 * 1024});
      if (bytes) result[kind] = validateReceipt(JSON.parse(bytes.toString('utf8')));
    }));
    return result;
  }
  return {
    read,
    async write(scope, kind, value) {
      validateReceiptScope(scope);validateReceipt(value);
      const receipt = kind === 'mcp' && !('client' in value)
        ? {...value,client:(await read(scope,['mcp'])).mcp?.client ?? null} : value;
      await store.put(onboardingReceiptKey(prefix,scope,kind), Buffer.from(JSON.stringify(receipt)), 'application/json');
      return receipt;
    },
  };
}
