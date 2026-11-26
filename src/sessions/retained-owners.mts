import {normalizeS3Prefix} from './s3-key-prefix.mjs';
import type {ObjectStore} from './types.mjs';

type Source = Pick<ObjectStore, 'listPage'>;
const hash = /^[0-9a-f]{64}$/;

async function* childHashes(store: Source, parent: string, strict: boolean): AsyncGenerator<string> {
  const cursors = new Set<string>();
  let cursor: string | null = null, previous='';
  do {
    const page = await store.listPage(parent, {delimiter: '/', continuationToken: cursor,...(strict?{requireComplete:true}:{})});
    if (!Array.isArray(page.prefixes)) throw new Error('Owner inventory requires directory listings');
    cursor = page.nextToken;
    if (cursor !== null) {
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('Invalid owner inventory cursor');
      cursors.add(cursor);
    }
    for (const path of page.prefixes) {
      const id = path.slice(parent.length, -1);
      if (!hash.test(id) || path !== parent + id + '/') throw new Error('Unexpected owner inventory prefix');
      if(strict && previous>=id)throw new Error('Repeated or unordered owner inventory prefix');
      previous=id;yield id;
    }
  } while (cursor !== null);
}

/** List owner scopes without descending into raw sessions or reading object bodies.
 * A single-tenant operator can bind discovery to its configured tenant hash. */
export async function* retainedOwnerScopes(store: Source, prefix: string, tenantHash?: string, strict=false): AsyncGenerator<string> {
  const root = normalizeS3Prefix(prefix);
  if (!root) throw new Error('Owner inventory requires a session prefix');
  if (tenantHash !== undefined && !hash.test(tenantHash)) throw new Error('Invalid owner inventory tenant');
  const tenants = tenantHash === undefined ? childHashes(store, root + 'tenants/',strict) : [tenantHash];
  for await (const tenant of tenants) {
    const users = 'tenants/' + tenant + '/users/';
    for await (const user of childHashes(store, root + users,strict)) yield users + user;
  }
}
