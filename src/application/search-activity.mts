import {z} from 'zod';
import {usageRange} from './usage-range.mjs';

export const historyRequest = z.strictObject({
  kind:z.enum(['agent','proactive']),
  before:z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).optional(),
  /** Searches are retained for 30 days; '7d' narrows the list, 'all' lists what is retained. */
  range:usageRange.optional(),
  /** Proactive checks that returned at least one result: OpenCrawl context edits. */
  edits:z.literal(true).optional(),
  /** List keyword queries for the Overview. Keyword-free browse calls still count in totals. */
  withQuery:z.literal(true).optional(),
});
export const activityRequest = z.strictObject({range: usageRange.optional(), basis: z.literal('events').optional()});
export const historyRead = historyRequest.extend({basis: z.literal('events').optional()})
  .refine(input => !input.withQuery || (input.kind === 'agent' && input.basis === 'events'));
export type HistoryRequest = z.infer<typeof historyRequest>;
export interface SearchActivityRow {
  permalinkId?:string;
  id:string; at:string; userId:string; operation:string; queries:string[];
  agentName?:string;
  harness:string|null; sessionId:string|null; messageId:string|null; message:string|null;
  returned:number|null; outcome:'complete'|'failed'|'unknown'; delivered:boolean;
  /** From a billing meter: this row is one receipt, and this is what it cost and why. */
  charge?:{credits:number;reason:'charged'|'no_results'|'failed'};
  /** Why the search text is not shown: another member's private session, erased with its session, past retention, or never recorded. */
  withheld?:'private'|'session_deleted'|'expired'|'unrecorded';
}
export interface SearchActivityPage {
  rows:SearchActivityRow[]; next:NonNullable<HistoryRequest['before']>|null;
}
export interface CallTotals {
  /** First UTC day with tracked calls; earlier days in daily are null (not tracked). */
  since:string; includesEarlierCalls?:boolean; calls:number; agentSearches:number; proactiveChecks:number; nonSilent:number; delivered:number;
  /** Set when the counts come from a billing meter: only searches delivered with results are counted. */
  charged?:true;
  /** With a billing meter: agent searches in the range that were not charged, and credits per charged search. */
  uncharged?:{noResults:number;failed:number};
  rates?:{agent:number;proactive:number};
  /** Every UTC day of the requested range through today. */
  daily?:Array<{date:string;agentSearches:number|null;nonSilent:number|null}>;
}
