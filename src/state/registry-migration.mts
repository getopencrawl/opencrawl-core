import {createHash} from 'node:crypto';
import type {Environment,IntegrationRecord} from '../integrations/types.mjs';
import {ensureRegistrySchema} from '../integrations/local-registry.mjs';
import type {ApplicationDatabase} from './postgres.mjs';
import {canonical,openLegacySqlite,sourceTables,sourceColumns,sourceRows,digestRows,type ImportMode,type ImportTable,type ImportReceipt} from './sqlite-import.mjs';

const binding:ImportTable={name:'integration_binding',columns:{id:'number',organization:'text',environment:'text'},primary:['id'],order:0};
const integrations:ImportTable={name:'integrations',columns:{id:'text',user_id:'text',record:'json'},primary:['id'],order:1};
/** Offline-only exact registry import. It does not transition lifecycle state,
 * synthesize provider credentials, or replay external mutations. */
export async function migrateRegistrySqlite({database,path,organizationId,environment='selfhost',mode}:{database:ApplicationDatabase;path:string;organizationId:string;environment?:Environment;mode:ImportMode}){
  if(!['check','migrate','verify'].includes(mode)||!/^org_[A-Za-z0-9]+$/.test(organizationId))throw new Error('Invalid registry migration configuration');
  const source=await openLegacySqlite(path);
  try {
    const names=sourceTables(source);
    if(names.length!==2||!names.includes(binding.name)||!names.includes(integrations.name))throw new Error('Legacy registry contains unknown or missing tables');
    const bindingColumns=sourceColumns(source,binding),recordColumns=sourceColumns(source,integrations);
    if(bindingColumns.length!==3||recordColumns.length!==3)throw new Error('Legacy registry has missing columns');
    const bindings=[...sourceRows(source,binding,bindingColumns)];
    if(bindings.length!==1||bindings[0]?.id!==1||bindings[0]?.organization!==organizationId||bindings[0]?.environment!==environment)throw new Error('Legacy registry belongs to another organization or environment');
    function* records(){
      for(const row of sourceRows(source,integrations,recordColumns)){
        const record=row.record as IntegrationRecord;
        if(!record||typeof record!=='object'||Array.isArray(record)||record.tenantId!==organizationId||record.environment!==environment||record.integrationId!==row.id||record.userId!==row.user_id||!/^user_[A-Za-z0-9]+$/.test(record.userId)||!/^int_[a-f0-9]{26}$/.test(record.integrationId)||!/^[a-z]+$/.test(record.provider)||!['connecting','provisioning','active','disconnecting','disconnected','error'].includes(record.status))throw new Error('Legacy registry contains an invalid or foreign-scoped record');
        yield row;
      }
    }
    const inputs=[{table:binding.name,source:digestRows(bindings)},{table:integrations.name,source:digestRows(records())}];
    if(mode==='migrate')await ensureRegistrySchema(database);
    return await database.transaction(async client=>{
      if(mode==='migrate'){
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[database.namespace+':registry:import']);
        await client.query('INSERT INTO opencrawl_integration_bindings(namespace,organization_id,environment) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[database.namespace,organizationId,environment]);
        for(const row of records()){
          const record=row.record as IntegrationRecord;
          await client.query('INSERT INTO opencrawl_integrations(namespace,environment,tenant_id,user_id,integration_id,provider,status,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING',[database.namespace,environment,organizationId,record.userId,record.integrationId,record.provider,record.status,JSON.stringify(record)]);
        }
      }
      const bindingExists=Boolean((await client.query("SELECT to_regclass('public.opencrawl_integration_bindings') AS name")).rows[0]?.name);
      const recordsExist=Boolean((await client.query("SELECT to_regclass('public.opencrawl_integrations') AS name")).rows[0]?.name);
      const targetBinding=bindingExists?digestRows((await client.query('SELECT 1 AS id,organization_id AS organization,environment FROM opencrawl_integration_bindings WHERE namespace=$1',[database.namespace])).rows):null;
      // Keyset pages bound memory, while the digest covers every row in the
      // namespace, including any unexpected foreign scope or extra target row.
      let targetRecords:ReturnType<typeof digestRows>|null=null;
      if(recordsExist){
        const hash=createHash('sha256');let count=0,cursor:string[]|undefined;
        for(;;){
          const {rows}=await client.query(`SELECT integration_id AS id,user_id,record,environment,tenant_id FROM opencrawl_integrations WHERE namespace=$1${cursor?' AND (integration_id COLLATE "C",environment COLLATE "C",tenant_id COLLATE "C")>($2,$3,$4)':''} ORDER BY integration_id COLLATE "C",environment COLLATE "C",tenant_id COLLATE "C" LIMIT 256`,[database.namespace,...(cursor??[])]);
          for(const row of rows){if(row.environment!==environment||row.tenant_id!==organizationId)throw new Error('Target registry contains foreign scope');hash.update(canonical({id:row.id,user_id:row.user_id,record:row.record})+'\n');count++;}
          if(rows.length<256)break;const row=rows.at(-1)!;cursor=[row.id,row.environment,row.tenant_id];
        }
        targetRecords={rows:count,sha256:hash.digest('hex')};
      }
      const receipts:ImportReceipt[]=inputs.map((input,i)=>{const target=i===0?targetBinding:targetRecords;return {...input,target,matches:target?.rows===input.source.rows&&target.sha256===input.source.sha256};});
      if(mode!=='check'&&receipts.some(receipt=>!receipt.matches))throw new Error('Registry migration verification failed');
      return {domain:'registry' as const,mode,organizationId,tables:receipts,verified:receipts.every(receipt=>receipt.matches)};
    });
  }finally{source.close();}
}
