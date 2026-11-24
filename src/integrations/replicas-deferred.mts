import type {ApplicationDatabase} from '../state/postgres.mjs';
import type {ReplicasConversation} from './replicas-api.mjs';
import type {SnapshotProgress,SnapshotRefresh} from './replicas-snapshots.mjs';
import type {ImportIssue} from './replicas-recovery.mjs';

export interface HistoryCheckpoint {
  before:string|null;historyCursors:string[];occurrences:Record<string,number>;pageLimit?:number;maxPageLimit?:number;chatAttempts?:number;progress?:SnapshotProgress|null;refresh?:SnapshotRefresh|null;
}
export const emptyCheckpoint=():HistoryCheckpoint=>({before:null,historyCursors:[],occurrences:{},pageLimit:100,maxPageLimit:undefined,chatAttempts:0,progress:null,refresh:null});
export function checkpoint({before,historyCursors,occurrences,pageLimit,maxPageLimit,chatAttempts,progress,refresh}:HistoryCheckpoint):HistoryCheckpoint{
  return {before,historyCursors,occurrences,pageLimit,maxPageLimit,chatAttempts,progress:progress??null,refresh:refresh??null};
}
type DeferredIssue=ImportIssue&{continuation?:true};
interface DeferredRecord {id:string;retry_at:Date;chat:ReplicasConversation;checkpoint:HistoryCheckpoint;issue:DeferredIssue}
type Client=Pick<ApplicationDatabase['pool'],'query'>;
const samePage=`namespace=$1 AND tenant=$2 AND chat->>'workspace_id'=$3 AND chat->>'chat_id'=$4
  AND (checkpoint->>'before') IS NOT DISTINCT FROM $5 AND COALESCE((checkpoint->>'pageLimit')::int,100)=$6
  AND issue->>'operation'='history' AND NOT (issue ? 'continuation')`;
// Keep the exact catalog record for recovery if its chat reappears.
export const confirmedAbsence=`issue ? 'workspaceAbsentAt' AND NOT (issue ? 'continuation') AND checkpoint->>'before' IS NULL`;
const sameMissingPage=`${samePage} AND issue->>'httpStatus'='404'`;

/** The caller holds the tenant import lock for the entire activity. A shared
 * backoff only suppresses an identical 404 read. Each catalog row retains its
 * own metadata, occurrence counters, ingest handoff and completion. */
export function deferredHistory(client:Client,namespace:string,tenant:string){
  const scope=[namespace,tenant];
  const page=(chat:ReplicasConversation,position:HistoryCheckpoint)=>[...scope,chat.workspace_id,chat.chat_id,position.before,position.pageLimit??100];
  return {
    async reconcileRosters(importId:string,now:number){
      // Older rows and aliases can have a negative history read and a ready roster
      // in separate transactions. Reuse only a current, same-generation roster.
      await client.query(`UPDATE opencrawl_replicas_deferred d
        SET issue=jsonb_set(d.issue,'{workspaceAbsentAt}',to_jsonb(i.checked_at))
        FROM opencrawl_replicas_workspace_inventories i
        WHERE d.namespace=$1 AND d.tenant=$2 AND d.issue->>'importId'=$3
          AND i.namespace=d.namespace AND i.tenant=d.tenant AND i.import_id=$3 AND i.workspace=d.chat->>'workspace_id'
          AND i.result='ready' AND i.checked_at BETWEEN $4::timestamptz-interval '24 hours' AND $4
          AND i.chat_ids IS NOT NULL AND NOT (d.chat->>'chat_id'=ANY(i.chat_ids))
          AND NOT(d.issue ? 'workspaceAbsentAt' OR d.issue ? 'continuation') AND d.checkpoint->>'before' IS NULL
          AND d.issue->>'operation'='history' AND (d.issue->>'httpStatus'='404' OR d.issue->>'reason' IN ('empty_unverified','empty_with_messages'))`,
        [...scope,importId,new Date(now)]);
    },
    async oldest(preferContinuation:boolean,now:number){
      if(preferContinuation){
        const due=await client.query<DeferredRecord>(`SELECT id,retry_at,chat,checkpoint,issue FROM opencrawl_replicas_deferred
          WHERE namespace=$1 AND tenant=$2 AND issue ? 'continuation' AND checkpoint->>'before' IS NOT NULL AND retry_at<=$3
          ORDER BY retry_at,id LIMIT 1`,[...scope,new Date(now).toISOString()]);
        if(due.rows[0])return {row:due.rows[0],wake:due.rows[0].retry_at.getTime()};
      }
      const {rows:[row]}=await client.query<DeferredRecord>(`SELECT id,retry_at,chat,checkpoint,issue FROM opencrawl_replicas_deferred
        WHERE namespace=$1 AND tenant=$2 AND NOT (${confirmedAbsence}) ORDER BY retry_at,id LIMIT 1`,scope);
      return row?{row,wake:row.retry_at.getTime()}:undefined;
    },
    async remove(row:DeferredRecord){
      await client.query('DELETE FROM opencrawl_replicas_deferred WHERE namespace=$1 AND tenant=$2 AND retry_at=$3 AND id=$4',[...scope,row.retry_at,row.id]);
    },
    async save(chat:ReplicasConversation,position:HistoryCheckpoint,issue:DeferredIssue,retryAt:string){
      const checkRoster=!issue.workspaceAbsentAt&&!issue.continuation&&!position.before&&issue.operation==='history'&&
        (issue.httpStatus===404||issue.reason==='empty_unverified'||issue.reason==='empty_with_messages');
      await client.query(`INSERT INTO opencrawl_replicas_deferred(namespace,tenant,retry_at,chat,checkpoint,issue)
        SELECT $1,$2,$3,$4,$5,$6::jsonb || COALESCE((SELECT jsonb_build_object('workspaceAbsentAt',checked_at)
          FROM opencrawl_replicas_workspace_inventories WHERE $7 AND namespace=$1 AND tenant=$2 AND import_id=$8
          AND workspace=$9 AND result='ready' AND chat_ids IS NOT NULL AND NOT ($10=ANY(chat_ids))
          AND checked_at BETWEEN $11::timestamptz-interval '24 hours' AND $11),'{}'::jsonb)`,
        [...scope,retryAt,chat,checkpoint(position),issue,checkRoster,issue.importId??null,chat.workspace_id,chat.chat_id,issue.at]);
    },
    async backoff(chat:ReplicasConversation,position:HistoryCheckpoint,importId:string){
      return (await client.query<{issue:ImportIssue;retry_at:Date}>(`SELECT issue,retry_at FROM opencrawl_replicas_deferred WHERE ${sameMissingPage}
        AND issue->>'importId'=$7 AND NOT (${confirmedAbsence}) ORDER BY retry_at DESC LIMIT 1`,[...page(chat,position),importId])).rows[0];
    },
    async shareFailure(chat:ReplicasConversation,position:HistoryCheckpoint,issue:ImportIssue,retryAt:string){
      const result=await client.query(`UPDATE opencrawl_replicas_deferred SET retry_at=$7,issue=$8,
        checkpoint=jsonb_set(checkpoint,'{chatAttempts}',to_jsonb($9::int))
        WHERE ${sameMissingPage} AND NOT (${confirmedAbsence})`,[...page(chat,position),retryAt,issue,issue.attempt]);
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
      const due="GREATEST((issue->>'providerRetryAt')::timestamptz,LEAST(retry_at,$7))";
      await client.query(`UPDATE opencrawl_replicas_deferred SET retry_at=${due},issue=(issue-'workspaceAbsentAt')||jsonb_build_object('retryAt',${due})
        WHERE ${samePage} AND (retry_at>$7 OR issue ? 'workspaceAbsentAt') AND (issue->>'httpStatus'='404' OR ($8::boolean AND issue->>'reason' IN ('empty_with_messages','empty_unverified')))`,
        [...page(chat,position),now,hasContent]);
    },
  };
}
