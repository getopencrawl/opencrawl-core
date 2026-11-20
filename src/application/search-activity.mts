import {z} from 'zod';

export const historyRequest = z.strictObject({
  kind:z.enum(['agent','proactive']),
  before:z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).optional(),
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
  since:string; includesEarlierCalls?:boolean; calls:number; agentSearches:number; proactiveChecks:number; nonSilent:number; delivered:number;
}
