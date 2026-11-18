import type {Bootstrap} from './types.mjs';

/** Only workspace-level display reports are eligible. Resource-level ACLs,
 * invitations, credentials, and writes require their own current reads. */
const routes: Record<string, readonly string[]> = {
  '/': ['console.usage', 'console.usageHighlights', 'console.usageDetails'],
  '/usage': ['console.usage', 'console.usageHighlights', 'console.usageDetails'],
  '/sources': ['console.sources'], '/integrations': ['console.sources'], '/data': ['console.sources'],
  '/team': ['console.team'], '/settings': ['console.team'], '/settings/team': ['console.team'],
};
export interface ConsoleReload<B extends Bootstrap = Bootstrap> {bootstrap: B; reports: Record<string, unknown>}
interface Entry {data: unknown; expires: number; sequence: number}
interface Bucket {tenant: string; entries: Map<string, Entry>}
const lifetime = 10 * 60_000;
export const maxReloadReportBytes = 96 * 1024;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Each runtime owns one bounded memory cache. A fresh admission is required to
 * obtain a document. Neither the HTTP cache nor browser storage holds reports. */
export function createConsoleReloadCache(extensions: Record<string, readonly string[]> = {}, now = Date.now) {
  const byPage = new Map(Object.entries({...routes, ...extensions}));
  const allowed = new Set(['console.bootstrap', ...Array.from(byPage.values()).flat()]);
  const buckets = new Map<string, Bucket>();
  let sequence = 0;
  function invalidate(tenant: string) {
    for (const [scope, bucket] of buckets) if (bucket.tenant === tenant) buckets.delete(scope);
  }
  function begin(tenant: string, scope: string, operation: string) {
    if (!allowed.has(operation) || !scope || !tenant) return;
    let bucket = buckets.get(scope);
    if (!bucket || bucket.tenant !== tenant) {
      if (buckets.size >= 96) buckets.delete(buckets.keys().next().value!);
      bucket = {tenant, entries: new Map()};
      buckets.set(scope, bucket);
    }
    const started = ++sequence;
    return (data: unknown) => {
      if (buckets.get(scope) !== bucket || (bucket.entries.get(operation)?.sequence ?? 0) > started) return;
      // Only the roster belongs to this workspace. The chooser and private
      // invitation URLs arrive on the live Team read.
      if (operation === 'console.team' && object(data)) {
        const invitations = Array.isArray(data.invitations) ? data.invitations.filter(object).map(({email, state}) => ({email, state})) : undefined;
        data = {...data, invitations, ...('workspaces' in data ? {workspaces: []} : {})};
      }
      const fits = object(data) && (!('cacheScope' in data) || data.cacheScope === scope)
        && Buffer.byteLength(JSON.stringify(data)) <= maxReloadReportBytes;
      // Keep the sequence even on an ineligible result so older reads cannot restore it.
      bucket.entries.set(operation, {data: fits ? data : undefined, expires: now() + lifetime, sequence: started});
    };
  }
  function read(tenant: string, scope: string, pathname: string): ConsoleReload | undefined {
    const bucket = buckets.get(scope);
    if (!bucket || bucket.tenant !== tenant || pathname.startsWith('/onboarding')) return;
    const at = now();
    const fresh = (operation: string) => {
      const entry = bucket.entries.get(operation);
      return entry && entry.expires > at ? entry.data : undefined;
    };
    const bootstrap = fresh('console.bootstrap') as Bootstrap | undefined;
    if (!bootstrap || bootstrap.cacheScope !== scope || (!bootstrap.setup && !bootstrap.onboarding.completed)) return;
    const reports: Record<string, unknown> = {};
    for (const operation of byPage.get(pathname) ?? []) {
      const data = fresh(operation);
      if (data !== undefined) reports[operation] = data;
    }
    return {bootstrap, reports};
  }
  async function forDocument(tenant: string, scope: string, pathname: string, revalidate: () => Promise<boolean>) {
    if (!read(tenant, scope, pathname)) return;
    if (!await revalidate()) {
      invalidate(tenant);
      return false;
    }
    // A concurrent write can invalidate the snapshot during admission.
    return read(tenant, scope, pathname);
  }
  return {begin, read, forDocument, invalidate};
}
export type ConsoleReloadCache = ReturnType<typeof createConsoleReloadCache>;
