import {z} from 'zod';
import {usageRange} from './usage-range.mjs';

export const historyRequest = z.strictObject({
  kind:z.enum(['agent','proactive']),
  before:z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).optional(),
  /** Searches are retained for 30 days; '7d' narrows the list, 'all' lists what is retained. */
  range:usageRange.optional(),
  /** Proactive checks that returned at least one result: OpenCrawl context edits. */
  edits:z.literal(true).optional(),
});
export type HistoryRequest = z.infer<typeof historyRequest>;
export interface SearchActivityRow {
  id:string; at:string; userId:string; operation:string; queries:string[];
  harness:string|null; sessionId:string|null; messageId:string|null; message:string|null;
  returned:number|null; outcome:'complete'|'failed'|'unknown'; delivered:boolean;
}
export interface SearchActivityPage {
  rows:SearchActivityRow[]; next:NonNullable<HistoryRequest['before']>|null;
}
export interface CallTotals {
  /** First UTC day with tracked calls; earlier days in daily are null (not tracked). */
  since:string; includesEarlierCalls?:boolean; calls:number; agentSearches:number; proactiveChecks:number; nonSilent:number; delivered:number;
  /** Every UTC day of the requested range through today. */
  daily?:Array<{date:string;agentSearches:number|null;nonSilent:number|null}>;
}
