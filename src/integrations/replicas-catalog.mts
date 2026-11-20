import type {ApplicationDatabase} from '../state/postgres.mjs';
import type {ReplicasConversation} from './replicas-api.mjs';
import {canonical,replicasDigest} from './replicas-events.mjs';
import {sourceRevision,type WorkspaceVersion} from './replicas-snapshots.mjs';

/** The rows and this page's selected queue commit in one tenant transaction.
 * Old registrations may have deferred records without a catalog fingerprint.
 * Compare those in bulk before adding work for the first daily scan. */
export async function selectCatalogRows(client:Pick<ApplicationDatabase['pool'],'query'>,scope:[string,string,string],rows:ReplicasConversation[],daily:boolean){
  const hashes=rows.map(chat=>replicasDigest(canonical(chat)));
  const inserted=hashes.length?await client.query<{record_hash:string}>(`INSERT INTO opencrawl_replicas_catalog_records(namespace,tenant,import_id,record_hash)
    SELECT $1,$2,$3,v FROM unnest($4::text[]) v ON CONFLICT DO NOTHING RETURNING record_hash`,[...scope,hashes]):{rows:[]};
  const unseen=new Set(inserted.rows.map(row=>row.record_hash));
  if(!daily)return rows;
  if(unseen.size){
    const legacy=(await client.query<{ordinal:number}>(`SELECT entry.ordinality::int AS ordinal FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY entry(chat,ordinality)
      WHERE EXISTS(SELECT 1 FROM opencrawl_replicas_deferred d WHERE d.namespace=$1 AND d.tenant=$2 AND
      d.chat->>'workspace_id'=entry.chat->>'workspace_id' AND d.chat->>'chat_id'=entry.chat->>'chat_id' AND d.chat=entry.chat)`,[scope[0],scope[1],JSON.stringify(rows)])).rows;
    for(const row of legacy)unseen.delete(hashes[row.ordinal-1]!);
  }
  const selected:ReplicasConversation[]=[];
  const versions=await client.query<{workspace:string;chat_id:string;version:Date;native:WorkspaceVersion;verify_next:boolean}>(`
    SELECT s.workspace,s.chat_id,s.source_version AS version,i.chat_versions->s.chat_id AS native,s.verify_next
    FROM (SELECT DISTINCT * FROM unnest($4::text[],$5::text[]) AS ids(workspace,chat_id)) candidates
    JOIN opencrawl_replicas_snapshots s USING(workspace,chat_id)
    JOIN opencrawl_replicas_workspace_inventories i USING(namespace,tenant,import_id,workspace)
    WHERE s.namespace=$1 AND s.tenant=$2 AND s.import_id=$3 AND i.chat_versions ? s.chat_id`,
    [...scope,rows.map(c=>c.workspace_id),rows.map(c=>c.chat_id)]);
  const prior=new Map(versions.rows.map(r=>[r.workspace+':'+r.chat_id,r])),refreshing=new Set<string>();
  for(const [i,c] of rows.entries()){
    const pair=c.workspace_id+':'+c.chat_id,snapshot=prior.get(pair),revision=snapshot&&sourceRevision(c,snapshot.native);
    const changed=snapshot&&revision&&(snapshot.verify_next||Date.parse(revision)>snapshot.version.getTime())&&!refreshing.has(pair);
    if(unseen.delete(hashes[i]!)||changed){selected.push(c);if(revision)refreshing.add(pair);}
  }
  return selected;
}
