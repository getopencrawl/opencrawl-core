import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {ValueReport} from './reports.mjs';

// Measured value reports for the Usage page. A report is produced offline by replaying
// a workspace's own captured work (see the ROI analysis), then stored per tenant at
// <prefix>/value/tenants/<sha256(tenantId)>.json. The page shows nothing until one exists,
// and a malformed report is ignored rather than shown.
interface ObjectReader {get(key: string, options?: {maxBytes?: number}): Promise<Buffer | null>}

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const amount = z.number().finite().min(0).max(1e12);
const share = z.number().finite().min(0).max(100);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const label = z.string().min(1).max(200);
const schema = z.strictObject({
  schema: z.literal(1),
  measuredAt: day,
  window: z.strictObject({from: day, to: day, days: z.number().int().min(1).max(366)}),
  model: z.strictObject({model: label, input: amount, cacheRead: amount, cacheWrite: amount, output: amount, asOf: day, share}),
  savings: z.strictObject({tasks: count, heldOutTasks: count, turns: count, turnsPerTask: amount, turnPercent: share,
    tokens: z.strictObject({input: count, cacheRead: count, cacheWrite: count, output: count})}),
  observed: z.strictObject({from: day.nullable(), to: day.nullable(), conflictsAvoided: count, duplicatesAvoided: count, knowledgeReused: count,
    searches: count, searchesUseful: count, searchesUsed: count}),
});

export const valueReportKey = (prefix: string, tenantId: string) =>
  `${prefix}/value/tenants/${createHash('sha256').update(tenantId).digest('hex')}.json`;

/** Parses a stored report; returns null for anything that does not match schema 1 exactly. */
export function parseValueReport(raw: string): ValueReport | null {
  let value: unknown;
  try {value = JSON.parse(raw);} catch {return null;}
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function valueReports({store, prefix}: {store: ObjectReader; prefix: string}) {
  return {
    async read(tenantId: string): Promise<ValueReport | null> {
      const bytes = await store.get(valueReportKey(prefix, tenantId), {maxBytes: 64 * 1024});
      return bytes ? parseValueReport(bytes.toString('utf8')) : null;
    },
  };
}
export type ValueReports = ReturnType<typeof valueReports>;
