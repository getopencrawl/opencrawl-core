import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {fail} from '../errors.mjs';
import {sessionScope} from '../sessions/event-identity.mjs';
import type {Principal} from '../sessions/types.mjs';
import type {PauseWindow, RecordingPolicy, RecordingSignal} from '../sessions/recording.mjs';
import type {ApplicationDatabase} from './postgres.mjs';

const nowMs = 'floor(extract(epoch from clock_timestamp()) * 1000)::bigint';
const latest = 'SELECT * FROM opencrawl_recording_pauses WHERE namespace=$1 AND actor=$2 ORDER BY id DESC LIMIT 1';

export function createRecordingPolicy(db: ApplicationDatabase): RecordingPolicy & {ready(): Promise<void>} {
  let preparing: Promise<void> | undefined;
  function ready() {
    preparing ??= db.transaction(async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:recording:schema',0))");
      await c.query(`CREATE TABLE IF NOT EXISTS opencrawl_recording_pauses(
        namespace text NOT NULL, actor text NOT NULL, id bigint GENERATED ALWAYS AS IDENTITY,
        start_ms bigint NOT NULL, end_ms bigint, revision uuid NOT NULL,
        PRIMARY KEY(namespace,actor,id), CHECK(end_ms IS NULL OR end_ms >= start_ms))`);
    }).catch(error => {preparing = undefined; throw error;});
    return preparing;
  }
  function scope(p: Principal) {
    return [db.namespace,sessionScope(p)];
  }
  async function lock(c: PoolClient, key: string[], exclusive: boolean) {
    const fn = exclusive ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared';
    await c.query(`SELECT ${fn}(hashtextextended($1,0))`,[JSON.stringify(['recording',...key])]);
  }
  async function signal(c: Pick<PoolClient,'query'>, key: string[], known?: string): Promise<RecordingSignal> {
    // The state and optional history share one SQL snapshot. Steady-state clients receive only the sentinel.
    const row = (await c.query<{revision:string; paused:boolean; until:number|null; observed:number; windows:PauseWindow[]|null}>(`
      WITH last AS (${latest}), status AS (
        SELECT COALESCE((SELECT revision::text FROM last),'0') AS revision,
          EXISTS(SELECT 1 FROM last WHERE end_ms IS NULL OR end_ms > ${nowMs}) AS paused)
      SELECT status.*, ${nowMs}::double precision AS observed, (SELECT end_ms::double precision FROM last WHERE status.paused) AS until,
        CASE WHEN $3::text IS NOT NULL AND $3::text <> revision THEN
          COALESCE((SELECT jsonb_agg(jsonb_build_array(start_ms,end_ms) ORDER BY id)
            FROM opencrawl_recording_pauses WHERE namespace=$1 AND actor=$2),'[]'::jsonb) END AS windows
      FROM status`,[...key,known??null])).rows[0]!;
    return {revision:row.revision,paused:row.paused,until:row.until,observedAt:row.observed,...row.windows && {windows:row.windows}};
  }
  return {
    ready,
    async read(principal, known) {const key=scope(principal); await ready(); return signal(db.pool,key,known);},
    async change(principal, mode, expected) {
      if(principal.captureAccess !== undefined || principal.owner) fail(403,'Account owner required');
      const key=scope(principal); await ready();
      return db.transaction(async c => {
        await lock(c,key,true);
        const state=await signal(c,key);
        if(state.revision!==expected) fail(409,'Recording changed. Refresh and try again.');
        const end = mode==='hour' ? `${nowMs}+3600000` : mode==='resume' ? nowMs : 'NULL';
        if(state.paused) {
          await c.query(`UPDATE opencrawl_recording_pauses SET revision=$3,end_ms=${end}
            WHERE namespace=$1 AND actor=$2 AND id=(SELECT id FROM (${latest}) last)`,[...key,randomUUID()]);
        } else if(mode!=='resume') {
          await c.query(`INSERT INTO opencrawl_recording_pauses(namespace,actor,revision,start_ms,end_ms)
            VALUES ($1,$2,$3,${nowMs},${end})`,[...key,randomUUID()]);
        }
        const {revision,paused,until}=await signal(c,key);
        return {revision,paused,until};
      });
    },
    async capture(principal, revision, timestamps, write) {
      const key=scope(principal); await ready();
      return db.transaction(async c => {
        // The toggle waits for admitted writes. Slow request bodies are read before acquiring this lock.
        await lock(c,key,false);
        const times=timestamps.map(t=>typeof t==='string'?Date.parse(t):NaN);
        const row=(await c.query<{revision:string;paused:boolean;excluded:boolean}>(`
          WITH last AS (${latest})
          SELECT COALESCE((SELECT revision::text FROM last),'0') AS revision,
            EXISTS(SELECT 1 FROM last WHERE end_ms IS NULL OR end_ms > ${nowMs}) AS paused,
            EXISTS(SELECT 1 FROM opencrawl_recording_pauses p
              WHERE p.namespace=$1 AND p.actor=$2 AND ($3::boolean OR EXISTS(
                SELECT 1 FROM unnest($4::bigint[]) t WHERE t>=p.start_ms AND (p.end_ms IS NULL OR t<p.end_ms)))) AS excluded`,
          [...key,times.some(t=>!Number.isFinite(t)),times.filter(Number.isFinite)])).rows[0]!;
        if(row.paused) fail(423,'Recording is paused');
        if(row.revision!==(revision??'0')) fail(412,'Refresh recording permission');
        if(row.excluded) fail(422,'Capture overlaps a recording pause');
        return write();
      });
    },
  };
}
