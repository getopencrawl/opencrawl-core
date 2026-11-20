import type {ApplicationDatabase} from '../state/postgres.mjs';
import type {ReplicasConversation} from './replicas-api.mjs';
import type {ImportIssue} from './replicas-recovery.mjs';

export interface HistoryCheckpoint {
  before:string|null;historyCursors:string[];occurrences:Record<string,number>;pageLimit?:number;chatAttempts?:number;
}
export const emptyCheckpoint=():HistoryCheckpoint=>({before:null,historyCursors:[],occurrences:{},pageLimit:100,chatAttempts:0});
export function checkpoint({before,historyCursors,occurrences,pageLimit,chatAttempts}:HistoryCheckpoint):HistoryCheckpoint{
  return {before,historyCursors,occurrences,pageLimit,chatAttempts};
}
type DeferredIssue=ImportIssue&{continuation?:true};
interface DeferredRecord {id:string;retry_at:Date;chat:ReplicasConversation;checkpoint:HistoryCheckpoint;issue:DeferredIssue}
type Client=Pick<ApplicationDatabase['pool'],'query'>;
const samePage=`namespace=$1 AND tenant=$2 AND chat->>'workspace_id'=$3 AND chat->>'chat_id'=$4
  AND (checkpoint->>'before') IS NOT DISTINCT FROM $5 AND COALESCE((checkpoint->>'pageLimit')::int,100)=$6
  AND issue->>'operation'='history' AND NOT (issue ? 'continuation')`;
const sameMissingPage=`${samePage} AND issue->>'httpStatus'='404'`;

/** The caller holds the tenant import lock for the entire activity. A shared
 * backoff only suppresses an identical 404 read. Each catalog row retains its
 * own metadata, occurrence counters, ingest handoff and completion. */
export function deferredHistory(client:Client,namespace:string,tenant:string){
  const scope=[namespace,tenant];
  const page=(chat:ReplicasConversation,position:HistoryCheckpoint)=>[...scope,chat.workspace_id,chat.chat_id,position.before,position.pageLimit??100];
  return {
    async onlyAbsent(){
      const result=await client.query<{only_absent:boolean}>(`SELECT NOT EXISTS(SELECT 1 FROM opencrawl_replicas_deferred
        WHERE namespace=$1 AND tenant=$2 AND (NOT(issue ? 'workspaceAbsentAt') OR issue ? 'continuation' OR checkpoint->>'before' IS NOT NULL)) AS only_absent`,scope);
      return result.rows[0].only_absent;
    },
    async oldest(){
      return (await client.query<DeferredRecord>(`SELECT id,retry_at,chat,checkpoint,issue FROM opencrawl_replicas_deferred
        WHERE namespace=$1 AND tenant=$2 ORDER BY retry_at,id LIMIT 1`,scope)).rows[0];
    },
    async remove(row:DeferredRecord){
      await client.query('DELETE FROM opencrawl_replicas_deferred WHERE namespace=$1 AND tenant=$2 AND retry_at=$3 AND id=$4',[...scope,row.retry_at,row.id]);
    },
    async save(chat:ReplicasConversation,position:HistoryCheckpoint,issue:DeferredIssue,retryAt:string){
      await client.query(`INSERT INTO opencrawl_replicas_deferred(namespace,tenant,retry_at,chat,checkpoint,issue)
        VALUES($1,$2,$3,$4,$5,$6)`,[...scope,retryAt,chat,checkpoint(position),issue]);
    },
    async backoff(chat:ReplicasConversation,position:HistoryCheckpoint,importId:string){
      return (await client.query<{issue:ImportIssue;retry_at:Date}>(`SELECT issue,retry_at FROM opencrawl_replicas_deferred WHERE ${sameMissingPage}
        AND issue->>'importId'=$7 ORDER BY retry_at DESC LIMIT 1`,[...page(chat,position),importId])).rows[0];
    },
    async shareFailure(chat:ReplicasConversation,position:HistoryCheckpoint,issue:ImportIssue,retryAt:string){
      const result=await client.query(`UPDATE opencrawl_replicas_deferred SET retry_at=$7,issue=$8,
        checkpoint=jsonb_set(checkpoint,'{chatAttempts}',to_jsonb($9::int))
        WHERE ${sameMissingPage}`,[...page(chat,position),retryAt,issue,issue.attempt]);
      return result.rowCount??0;
    },
    async shareEmptyPage(chat:ReplicasConversation,position:HistoryCheckpoint,issue:ImportIssue,retryAt:string){
      // Rows qualify only after independently observing the same empty result
      // for this generation. An alias with different sender evidence can succeed.
      const result=await client.query(`UPDATE opencrawl_replicas_deferred SET retry_at=GREATEST(retry_at,$7::timestamptz),
        checkpoint=jsonb_set(checkpoint,'{chatAttempts}',to_jsonb(GREATEST(COALESCE((checkpoint->>'chatAttempts')::int,0),$8::int))),
        issue=issue||jsonb_build_object('sharedAt',$9::text,'sharedRequestId',$10::text,'retryAt',GREATEST(retry_at,$7::timestamptz))
        WHERE ${samePage} AND issue->>'reason'=$11 AND issue->>'importId'=$12`,
        [...page(chat,position),retryAt,issue.attempt,issue.at,issue.requestId??null,issue.reason,issue.importId]);
      return result.rowCount??0;
    },
    async releaseBackoff(chat:ReplicasConversation,position:HistoryCheckpoint,now:string,hasContent:boolean){
      await client.query(`UPDATE opencrawl_replicas_deferred SET retry_at=LEAST(retry_at,$7),issue=(issue-'workspaceAbsentAt')||jsonb_build_object('retryAt',LEAST(retry_at,$7)) WHERE ${samePage} AND retry_at>$7 AND (issue->>'httpStatus'='404' OR ($8::boolean AND issue->>'reason' IN ('empty_with_messages','empty_unverified')))`,
        [...page(chat,position),now,hasContent]);
    },
  };
}
