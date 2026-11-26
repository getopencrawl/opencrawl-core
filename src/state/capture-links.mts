import {createHash} from 'node:crypto';
import {captureIdPattern,type CaptureCollection} from '../application/capture-links.mjs';
import type {ApplicationDatabase} from './postgres.mjs';
export {capturePage} from '../application/capture-links.mjs';

export {workspaceLinkHint} from './workspace-link.mjs';
import {workspaceLinkHint} from './workspace-link.mjs';

export function captureLinkMatchesWorkspace(id:string,tenantId:string) {
  return captureIdPattern.test(id) && id.slice(3,15)===workspaceLinkHint(tenantId);
}

export interface CaptureLinkKey {userId:string; harness:string; name:string}
export interface CaptureLinks {
  register(tenantId:string,collection:CaptureCollection,keys:CaptureLinkKey[]):Promise<string[]>;
  resolve(tenantId:string,collection:CaptureCollection,id:string):Promise<CaptureLinkKey|null>;
}

/** Add links in one write per collection, using only the visible page of results. */
interface LinkDocument {userId?:unknown;harness?:unknown;path?:unknown;sessionId?:unknown;permalinkId?:string}
export async function attachCaptureLinks(links:CaptureLinks,tenantId:string,collection:CaptureCollection,documents:LinkDocument[]) {
  const entries=documents.flatMap(doc=>{
    const {userId,harness}=doc, name=collection==='sessions'?doc.sessionId:doc.path;
    return typeof userId==='string' && typeof harness==='string' && typeof name==='string'
      ? [{doc,key:{userId,harness,name}}] : [];
  });
  const ids=await links.register(tenantId,collection,entries.map(entry=>entry.key));
  for (const [i,entry] of entries.entries()) entry.doc.permalinkId=ids[i];
}

/** The stored identity only locates a capture. Its library must authorize every read. */
export function createCaptureLinks(database:ApplicationDatabase):CaptureLinks {
  let preparing:Promise<void>|undefined;
  const ready = () => preparing ??= database.transaction(async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:capture-links:schema',0))");
    await db.query(`CREATE TABLE IF NOT EXISTS opencrawl_capture_links (
      namespace text NOT NULL, id text NOT NULL, tenant_id text NOT NULL,
      collection text NOT NULL CHECK(collection IN ('sessions','memories')),
      user_id text NOT NULL, harness text NOT NULL, name text NOT NULL, PRIMARY KEY(namespace,id))`);
  }).catch(error=>{preparing=undefined;throw error;});
  return {
    async register(tenantId,collection,keys) {
      if (!keys.length) return [];
      const hint=workspaceLinkHint(tenantId);
      const rows=keys.map(({userId,harness,name})=>{
        const digest=createHash('sha256').update(JSON.stringify([collection,tenantId,userId,harness,name])).digest();
        return {id:'oc_'+hint+digest.subarray(0,15).toString('base64url'),user_id:userId,harness,name};
      });
      await ready();
      // Stable ordering avoids opposing lock orders when overlapping pages arrive together.
      // Already indexed captures keep their original row.
      const unique=[...new Map(rows.map(row=>[row.id,row])).values()];
      await database.pool.query(`INSERT INTO opencrawl_capture_links(namespace,id,tenant_id,collection,user_id,harness,name)
        SELECT $1,r.id,$2,$3,r.user_id,r.harness,r.name FROM jsonb_to_recordset($4::jsonb) AS r(id text,user_id text,harness text,name text)
        ORDER BY r.id ON CONFLICT(namespace,id) DO NOTHING`,
        [database.namespace,tenantId,collection,JSON.stringify(unique)]);
      return rows.map(row=>row.id);
    },
    async resolve(tenantId,collection,id) {
      if (!captureIdPattern.test(id)) return null;
      await ready();
      const result=await database.pool.query<CaptureLinkKey>(`SELECT user_id AS "userId",harness,name FROM opencrawl_capture_links
        WHERE namespace=$1 AND id=$2 AND tenant_id=$3 AND collection=$4`,[database.namespace,id,tenantId,collection]);
      return result.rows[0] ?? null;
    },
  };
}
