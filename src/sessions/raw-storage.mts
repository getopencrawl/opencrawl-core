import {digest} from './event-identity.mjs';
import {isSessionHarness, type ObjectStore, type ReadOptions} from './types.mjs';

const hash = /^[a-f0-9]{64}$/;
const manifest = /^[a-f0-9]{64}\.json\.gz$/;
const immutable = (tail: string[]) => {
  if (tail[0] === 'attachments') return tail.length === 2 && hash.test(tail[1]);
  if (tail[0] === 'memories') return tail.length === 4 && ['codex','claude-code'].includes(tail[1]) &&
    hash.test(tail[2]) && /^\d+-[a-f0-9]{64}\.json\.gz$/.test(tail[3]);
  return isSessionHarness(tail[0]) && hash.test(tail[1]) && hash.test(tail[2]) &&
    (tail.length === 4 && manifest.test(tail[3]) || tail.length === 5 && tail[3] === 'attachments' && hash.test(tail[4]));
};

/** Keep the immutable inventory and all authorization state in the trusted store.
 * A raw writer can remove bytes, but cannot publish a record or change its author.
 * A null binding explicitly selects the operator's original storage layout. */
export function scopedCaptureStorage<T extends ObjectStore>(control: T, prefix: string,
  resolve: (tenantHash: string) => Promise<ObjectStore | null>): T {
  const root = prefix + '/tenants/';
  function scope(key: string) {
    if (!key.startsWith(root)) return null;
    const [tenant, users, user, ...tail] = key.slice(root.length).split('/');
    return hash.test(tenant) && users === 'users' && hash.test(user) ? {tenant, tail} : null;
  }
  async function rawStore(key: string) {
    const owner = scope(key);
    return owner && immutable(owner.tail) ? resolve(owner.tenant) : null;
  }
  const physical = (key: string, sha: string) => key + '/content-' + sha;
  function checksum(bytes: Buffer) {
    const sha = bytes.toString('ascii');
    if (bytes.length !== 64 || !hash.test(sha)) throw new Error('Invalid trusted capture receipt');
    return sha;
  }
  async function read(raw: ObjectStore, key: string, receipt: Buffer, options?: ReadOptions) {
    const sha = checksum(receipt);
    const bytes = await raw.get(physical(key, sha), options);
    if (!bytes || digest(bytes) !== sha) throw new Error('Capture content is missing or differs from its receipt');
    return bytes;
  }
  async function get(key: string, options?: ReadOptions) {
    const raw = await rawStore(key);
    if (!raw) return control.get(key, options);
    const receipt = await control.get(key, {maxBytes:64});
    return receipt && read(raw, key, receipt, options);
  }
  return {...control, get,
    async has(key: string, options?: ReadOptions) {
      const raw=await rawStore(key);
      if (!raw) return control.has ? control.has(key, options) : Boolean(await control.get(key, options));
      const receipt=await control.get(key,{maxBytes:64});
      return receipt ? Boolean(await read(raw,key,receipt,options)) : false;
    },
    async put(key: string, bytes: Uint8Array, type?: string) {
      const raw = await rawStore(key);
      if (!raw) return control.put(key, bytes, type);
      const sha = digest(bytes);
      await raw.put(physical(key, sha), bytes, type);
      // Simultaneous retries can encode different receivedAt timestamps. The first
      // published digest wins. Orphan variants are covered by session erasure.
      if (!await control.compareAndSet(key, null, Buffer.from(sha))) {
        const winner=await control.get(key,{maxBytes:64});
        if (!winner) throw new Error('Concurrent capture publication is unavailable');
        if (checksum(winner)!==sha) await read(raw,key,winner,{maxBytes:bytes.length+1024*1024});
      }
    },
    async purgePrefix(path: string, options: Parameters<NonNullable<ObjectStore['purgePrefix']>>[1] = {}) {
      if (!control.purgePrefix) throw new Error('Permanent capture deletion unavailable');
      const owner = scope(path);
      const raw = owner && (isSessionHarness(owner.tail[0]) || owner.tail[0] === 'attachments') ? await resolve(owner.tenant) : null;
      if (!raw) return control.purgePrefix(path, options);
      if (!raw.purgePrefix || options.selectVersion) throw new Error('Unsupported raw capture purge');
      const count = await control.purgePrefix(path, {...options, beforeDelete: async (key, receipt) => {
        if (options.beforeDelete) await options.beforeDelete(key, async () => read(raw, key, await receipt()));
      }});
      await raw.purgePrefix(path, {select: candidate => {
        const match = /^(.*)\/content-[a-f0-9]{64}$/.exec(candidate);
        return Boolean(match && scope(match[1])?.tenant === owner!.tenant && (options.select?.(match[1]) ?? true));
      }});
      return count;
    },
  };
}
