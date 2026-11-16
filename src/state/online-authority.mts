import {createHash, randomUUID} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import {prepareOnlineAuthorityTargetSchemaIn} from './online-authority-schema.mjs';

export interface OnlineWriteContext {sourceId: string; key: string}
export interface OnlineWriteAuthority {
  run<T>(context: OnlineWriteContext, callbacks: {legacy(): Promise<T>; journal(): Promise<T>}): Promise<T>;
}
export interface OnlineAuthorityBinding {namespace: string; epoch: string; protocol: string}
export interface OnlineEnrollmentEvidence extends OnlineAuthorityBinding {receiptHash: string}
export interface OnlineAuthorityStatus extends OnlineAuthorityBinding {
  mode: 'legacy' | 'journal' | 'target'; preparationReceiptHash: string; enrollmentReceiptHash: string | null;targetReceiptHash?:string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
function fail(code: string): never {throw Object.assign(new Error('Online write authority: ' + code), {code: 'ONLINE_AUTHORITY_' + code});}
function text(value: unknown, max: number, label: string): asserts value is string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max || value.includes('\0')) fail('INVALID_' + label);
}
function hash(value: string) {return createHash('sha256').update(value).digest('hex');}
class LegacyNotApplied extends Error {
  constructor(readonly rejection: unknown) {super('Legacy mutation was definitively not applied');}
}
/** Only an adapter with a definitive service rejection may call this. A timeout,
 * network error, stale read or arbitrary status does not establish no effect.
 * The authority preserves the original business exception after clearing the
 * completed dispatch, so an expected CAS conflict does not strand activation. */
export function rejectOnlineLegacyMutation(error: unknown): never {throw new LegacyNotApplied(error);}

/** Migration-only legacy-to-journal authority. The pool MUST be reserved for
 * this gate, separate from pools used by callbacks: holding every callback pool
 * connection while waiting for a second connection would deadlock admission.
 *
 * Fleet enrollment remains the caller's responsibility. prepare() is inert;
 * activate() is an explicit operator action after all incompatible processes
 * and external writers have drained. Readers remain compatible in both modes.
 * This does not switch application reads/writes to the final typed target.
 */
export function createOnlineWriteAuthority({database, epoch, protocol}: {
  database: {pool: Pool; namespace: string}; epoch: string; protocol: string;
}) {
  text(database.namespace, 2048, 'NAMESPACE'); text(protocol, 256, 'PROTOCOL');
  if (!uuid.test(epoch)) fail('INVALID_EPOCH');
  const binding = Object.freeze({namespace: database.namespace, epoch, protocol});
  const gate = JSON.stringify(['online-write-authority', binding.namespace]);
  const keyGate = (sourceId: string, key: string) => JSON.stringify(['online-write-authority-key', binding.namespace, sourceId, key]);

  async function locked<T>(exclusive: boolean, context: OnlineWriteContext | null, run: (client: PoolClient, alive: () => void) => Promise<T>,nonblocking=false) {
    const client = await database.pool.connect();
    let acquired = false, acquiredKey = false, broken = false, destroy = false;
    const onError = () => {broken = true;}; client.on('error', onError);
    const alive = () => {if (broken) fail('LOCK_CONNECTION_LOST');};
    try {
      // An acquisition timeout is ambiguous: destroy the connection even when
      // the server may have acquired a lock after the query promise rejected.
      if(nonblocking){if((await client.query(`SELECT pg_try_advisory_lock${exclusive ? '' : '_shared'}(hashtextextended($1,0)) AS acquired`,[gate])).rows[0]?.acquired!==true)fail('BUSY');}
      else await client.query(`SELECT pg_advisory_lock${exclusive ? '' : '_shared'}(hashtextextended($1,0))`, [gate]); acquired = true;
      if (context) {await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [keyGate(context.sourceId, context.key)]); acquiredKey = true;}
      alive(); const result = await run(client, alive); alive(); return result;
    } catch (error) {destroy = true; throw error;}
    finally {
      try {
        if (!destroy && !broken) {
          if (acquiredKey && (await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked', [keyGate(context!.sourceId, context!.key)])).rows[0]?.unlocked !== true) destroy = true;
          if (acquired && (await client.query(`SELECT pg_advisory_unlock${exclusive ? '' : '_shared'}(hashtextextended($1,0)) AS unlocked`, [gate])).rows[0]?.unlocked !== true) destroy = true;
        }
      } catch {destroy = true;}
      client.removeListener('error', onError); client.release(destroy || broken);
    }
  }
  async function transaction<T>(client: PoolClient, run: () => Promise<T>) {
    await client.query('BEGIN');
    try {const value = await run(); await client.query('COMMIT'); return value;}
    catch (error) {await client.query('ROLLBACK').catch(() => {}); throw error;}
  }
  async function readIn(client: PoolClient): Promise<OnlineAuthorityStatus> {
    const row = (await client.query("SELECT epoch,protocol,mode,preparation_receipt_hash,enrollment_receipt_hash,to_jsonb(w)->>'target_receipt_hash' AS target_receipt_hash FROM opencrawl_online_write_authorities w WHERE namespace=$1", [binding.namespace])).rows[0];
    if (!row) fail('NOT_PREPARED');
    if (row.epoch !== epoch || row.protocol !== protocol) fail('BINDING_MISMATCH');
    if (!['legacy', 'journal','target'].includes(row.mode) || !sha.test(row.preparation_receipt_hash) ||
      (row.mode === 'legacy' ? row.enrollment_receipt_hash !== null : !sha.test(row.enrollment_receipt_hash))||
      (row.mode==='target'?!sha.test(row.target_receipt_hash??''):row.target_receipt_hash!==null)) fail('INVALID_STORED_STATE');
    return {...binding, mode: row.mode, preparationReceiptHash: row.preparation_receipt_hash, enrollmentReceiptHash: row.enrollment_receipt_hash,...(row.mode==='target'?{targetReceiptHash:String(row.target_receipt_hash)}:{})};
  }
  async function prepare({receiptHash}: {receiptHash: string}) {
    if (!sha.test(receiptHash)) fail('INVALID_PREPARATION_RECEIPT');
    return locked(true, null, client => transaction(client, async () => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:online-write-authority:schema',0))");
      await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_online_write_authorities(
        namespace text PRIMARY KEY,epoch uuid NOT NULL,protocol text NOT NULL,mode text NOT NULL CHECK(mode IN ('legacy','journal')),
        preparation_receipt_hash text NOT NULL CHECK(preparation_receipt_hash~'^[a-f0-9]{64}$'),enrollment_receipt_hash text,
        CHECK((mode='legacy' AND enrollment_receipt_hash IS NULL) OR (mode='journal' AND enrollment_receipt_hash IS NOT NULL AND enrollment_receipt_hash~'^[a-f0-9]{64}$')));
        CREATE TABLE IF NOT EXISTS opencrawl_online_legacy_inflight(
        namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,key_hash text NOT NULL,source_key text NOT NULL,
        operation_id uuid NOT NULL,started_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(namespace,source_id,key_hash));`);
      await client.query("INSERT INTO opencrawl_online_write_authorities(namespace,epoch,protocol,mode,preparation_receipt_hash) VALUES($1,$2,$3,'legacy',$4) ON CONFLICT DO NOTHING", [binding.namespace, epoch, protocol, receiptHash]);
      const state = await readIn(client);
      if (state.preparationReceiptHash !== receiptHash) fail('PREPARATION_RECEIPT_CHANGED');
      return state;
    }));
  }
  async function run<T>(input: OnlineWriteContext, callbacks: {legacy(): Promise<T>; journal(): Promise<T>}): Promise<T> {
    text(input.sourceId, 2048, 'SOURCE'); text(input.key, 8192, 'KEY');
    if (typeof callbacks.legacy !== 'function' || typeof callbacks.journal !== 'function') fail('INVALID_CALLBACK');
    const context = {...input}, legacy = callbacks.legacy, journal = callbacks.journal;
    return locked(false, context, async (client, alive) => {
      const state = await readIn(client);
      if(state.mode==='target')fail('TARGET_ADMITTED');
      if (state.mode === 'journal') return journal();
      const values = [binding.namespace, epoch, context.sourceId, hash(context.key), context.key, randomUUID()];
      const inserted = await client.query(`INSERT INTO opencrawl_online_legacy_inflight(namespace,epoch,source_id,key_hash,source_key,operation_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING operation_id`, values);
      if (inserted.rowCount !== 1) fail('LEGACY_OUTCOME_UNRESOLVED');
      // Committed before dispatch. A lost gate connection, callback exception or
      // lost completion acknowledgement leaves this durable blocker. A released
      // advisory lock alone never proves the external legacy IO has stopped.
      alive();
      let result: T | undefined, rejection: LegacyNotApplied | undefined;
      try {result = await legacy();} catch (error) {if (!(error instanceof LegacyNotApplied)) throw error; rejection = error;}
      alive();
      const completed = await client.query('DELETE FROM opencrawl_online_legacy_inflight WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND key_hash=$4 AND source_key=$5 AND operation_id=$6', values);
      if (completed.rowCount !== 1) fail('LEGACY_OPERATION_CHANGED');
      if (rejection) throw rejection.rejection;
      return result as T;
    });
  }
  async function status() {return locked(false, null, readIn);}
  async function pending({limit = 64}: {limit?: number} = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) fail('INVALID_PAGE_LIMIT');
    return locked(false, null, async client => {
      await readIn(client);
      const rows = (await client.query('SELECT source_id,source_key,operation_id,started_at FROM opencrawl_online_legacy_inflight WHERE namespace=$1 ORDER BY started_at,operation_id LIMIT $2', [binding.namespace, limit + 1])).rows;
      return {entries: rows.slice(0, limit).map(row => ({sourceId: row.source_id as string, key: row.source_key as string, operationId: row.operation_id as string, startedAt: (row.started_at as Date).toISOString()})), more: rows.length > limit};
    });
  }
  async function activate({receiptHash, verify}: {
    receiptHash: string; verify(binding: Readonly<OnlineAuthorityBinding>): Promise<OnlineEnrollmentEvidence>;
  }) {
    if (!sha.test(receiptHash) || typeof verify !== 'function') fail('INVALID_ENROLLMENT_RECEIPT');
    return locked(true, null, (client, alive) => transaction(client, async () => {
      const state = await readIn(client);
      if(state.mode==='target')fail('TARGET_ADMITTED');
      if (state.mode === 'journal') {
        if (state.enrollmentReceiptHash !== receiptHash) fail('ENROLLMENT_RECEIPT_CHANGED');
        return state;
      }
      if ((await client.query('SELECT 1 FROM opencrawl_online_legacy_inflight WHERE namespace=$1 LIMIT 1', [binding.namespace])).rows.length) fail('LEGACY_OUTCOME_UNRESOLVED');
      const evidence = await verify(binding); alive();
      if (evidence?.namespace !== binding.namespace || evidence.epoch !== epoch || evidence.protocol !== protocol || evidence.receiptHash !== receiptHash) fail('ENROLLMENT_EVIDENCE_MISMATCH');
      await client.query("UPDATE opencrawl_online_write_authorities SET mode='journal',enrollment_receipt_hash=$2 WHERE namespace=$1", [binding.namespace, receiptHash]);
      return readIn(client);
    }));
  }
  async function prepareFinalization(){return locked(true,null,client=>transaction(client,async()=>{
    await readIn(client);await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:online-write-authority:schema',0))");
    await prepareOnlineAuthorityTargetSchemaIn(client);return readIn(client);
  }));}
  /** Operator gate only, not admission. Acquire without queuing behind active
   * writes. The final sealer owns the bounded tail and same-client transaction;
   * loss of this connection makes its outcome uncertain and requires readback. */
  async function withFinalization<T>(expected:{preparationReceiptHash:string;enrollmentReceiptHash:string},runFinal:(client:PoolClient,alive:()=>void)=>Promise<T>){
    if(!sha.test(expected.preparationReceiptHash)||!sha.test(expected.enrollmentReceiptHash)||typeof runFinal!=='function')fail('INVALID_FINALIZATION');
    const frozen={...expected};
    return locked(true,null,async(client,alive)=>{
      const state=await readIn(client);if(state.mode!=='journal')fail(state.mode==='target'?'TARGET_ADMITTED':'NOT_ACTIVATED');
      if(state.preparationReceiptHash!==frozen.preparationReceiptHash||state.enrollmentReceiptHash!==frozen.enrollmentReceiptHash)fail('FINALIZATION_BINDING');
      if((await client.query('SELECT 1 FROM opencrawl_online_legacy_inflight WHERE namespace=$1 LIMIT 1',[binding.namespace])).rows.length)fail('LEGACY_OUTCOME_UNRESOLVED');
      return runFinal(client,alive);
    },true);
  }
  /** Reacquire the exact exclusive gate before resolving a lost commit reply.
   * A plain read of an absent receipt could race the original COMMIT. This gate
   * refuses while that transaction may still own authority; it changes no mode. */
  async function withFinalizationRecovery<T>(expected:{preparationReceiptHash:string;enrollmentReceiptHash:string},recover:(client:PoolClient,state:Readonly<OnlineAuthorityStatus>,alive:()=>void)=>Promise<T>){
    if(!sha.test(expected.preparationReceiptHash)||!sha.test(expected.enrollmentReceiptHash)||typeof recover!=='function')fail('INVALID_FINALIZATION');
    const frozen={...expected};
    return locked(true,null,async(client,alive)=>{
      const state=await readIn(client);
      if(state.mode==='legacy'||state.preparationReceiptHash!==frozen.preparationReceiptHash||state.enrollmentReceiptHash!==frozen.enrollmentReceiptHash)fail('FINALIZATION_BINDING');
      return recover(client,Object.freeze(state),alive);
    },true);
  }
  return {binding, prepare, run, status, pending, activate,prepareFinalization,withFinalization,withFinalizationRecovery};
}
