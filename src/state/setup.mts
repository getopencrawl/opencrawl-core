import {randomUUID} from 'node:crypto';
import {sessionScope} from '../sessions/event-identity.mjs';
import {validateSetupState,type SetupStateRecord,type SetupScope} from '../setup/state.mjs';
import type {ApplicationDatabase} from './postgres.mjs';

export interface SetupState {
  read(scope:SetupScope):Promise<{record:SetupStateRecord|null;version:string|null}>;
  save(scope:SetupScope,version:string|null,record:SetupStateRecord):Promise<boolean>;
}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** A bounded per-user setup record. It owns no other application state. */
export function createSetupState(database:ApplicationDatabase):SetupState & {ready():Promise<void>} {
  const namespace=database.namespace;
  let preparing:Promise<void>|undefined;
  return {
    async ready(){
      preparing??=(async()=>{
        await database.ready();
        await database.transaction(async client=>{
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:setup:schema',0))");
          await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_setup_status(
            namespace text NOT NULL, tenant_id text NOT NULL, user_id text NOT NULL,
            record jsonb NOT NULL, revision uuid NOT NULL,
            PRIMARY KEY(namespace,tenant_id,user_id),
            CHECK((record->'scope'->>'tenantId') IS NOT NULL AND record->'scope'->>'tenantId'=tenant_id),
            CHECK((record->'scope'->>'userId') IS NOT NULL AND record->'scope'->>'userId'=user_id))`);
          // Older services strictly validate the v1 record. Keep optional contact times alongside it.
          await client.query("ALTER TABLE opencrawl_setup_status ADD COLUMN IF NOT EXISTS agent_last_seen jsonb NOT NULL DEFAULT '{}'");
        });
      })().catch(error=>{preparing=undefined;throw error;});
      await preparing;
    },
    async read(input){
      const scope={tenantId:input.tenantId,userId:input.userId};sessionScope(scope);
      const {rows}=await database.pool.query('SELECT record,revision,agent_last_seen FROM opencrawl_setup_status WHERE namespace=$1 AND tenant_id=$2 AND user_id=$3',[namespace,scope.tenantId,scope.userId]);
      if(!rows.length)return {record:null,version:null};
      const row=rows[0];
      if(typeof row.revision!=='string'||!uuid.test(row.revision))throw new Error('Invalid setup revision');
      const record = validateSetupState(row.record, scope);
      for (const installation of record.installations) {
        for (const client of installation.clients) {
          const seen = row.agent_last_seen[installation.installationId]?.[client.client];
          if (typeof seen === 'string' && Number.isFinite(Date.parse(seen))) client.lastSeenAt = seen;
        }
      }
      return {record,version:row.revision};
    },
    async save(input,version,value){
      const scope={tenantId:input.tenantId,userId:input.userId};sessionScope(scope);
      if(version!==null&&!uuid.test(version))throw new Error('Invalid setup revision');
      const record=validateSetupState(value,scope);
      const contacts:Record<string,Record<string,string>> = Object.create(null);
      for (const installation of record.installations) {
        for (const client of installation.clients) {
          if (client.lastSeenAt) {
            const byAgent = contacts[installation.installationId] ??= {};
            byAgent[client.client] = client.lastSeenAt;
            delete client.lastSeenAt;
          }
        }
      }
      const args=[namespace,scope.tenantId,scope.userId,JSON.stringify(record),randomUUID(),JSON.stringify(contacts)];
      const result=version===null
        ?await database.pool.query('INSERT INTO opencrawl_setup_status(namespace,tenant_id,user_id,record,revision,agent_last_seen) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb) ON CONFLICT DO NOTHING',args)
        :await database.pool.query('UPDATE opencrawl_setup_status SET record=$4::jsonb,revision=$5,agent_last_seen=$6::jsonb WHERE namespace=$1 AND tenant_id=$2 AND user_id=$3 AND revision=$7',[...args,version]);
      return result.rowCount===1;
    },
  };
}
