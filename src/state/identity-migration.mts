import {getSchema} from 'better-auth/db';
import type {LocalIdentityOptions} from '../identity/better-auth.mjs';
import {identityOptions,ensureIdentitySchema} from '../identity/better-auth.mjs';
import {openLegacySqlite,sourceTables,sourceColumns,sourceRows,digestRows,targetDigest,copyTable,identifier,type ImportMode,type ImportTable,type ColumnType,type ImportReceipt} from './sqlite-import.mjs';

/** Reads the pinned provider schema rather than guessing which OAuth plugin tables
 * matter. The report contains counts/digests only, never stored credential data. */
export async function migrateIdentitySqlite(options:LocalIdentityOptions&{path:string;mode:ImportMode}){
  if(!['check','migrate','verify'].includes(options.mode))throw new Error('Invalid identity migration mode');
  const config=await identityOptions(options),schema=getSchema(config),tables:ImportTable[]=Object.entries(schema).map(([name,table])=>({name,primary:['id'],order:table.order,
    columns:{id:'text',...Object.fromEntries(Object.entries(table.fields).map(([field,attr])=>{
      const type:ColumnType=attr.type==='date'?'date':attr.type==='boolean'?'boolean':attr.type==='number'?(attr.bigint?'bigint':'number'):attr.type==='json'||attr.type==='string[]'||attr.type==='number[]'?'json':'text';return [field,type];
    }))}}));
  tables.push({name:'opencrawlIdentityBinding',columns:{singleton:'number',organizationId:'text'},primary:['singleton'],order:10000},
    {name:'opencrawlIdentityState',columns:{organizationId:'text',initialized:'number'},primary:['organizationId'],order:10001},
    {name:'opencrawlAccountEpoch',columns:{userId:'text',notBefore:'bigint'},primary:['userId'],order:10002});
  const source=await openLegacySqlite(options.path);
  try {
    const names=sourceTables(source),known=new Set(tables.map(table=>table.name));
    if(names.some(name=>!known.has(name)))throw new Error('Legacy identity database contains unknown tables; preserve it for a reviewed migration');
    if(!names.includes('opencrawlIdentityBinding')||source.prepare('SELECT organizationId FROM opencrawlIdentityBinding WHERE singleton=1').get()?.organizationId!==options.organizationId)
      throw new Error('Legacy identity database belongs to a different organization');
    if(names.includes('organization')&&source.prepare('SELECT id FROM organization WHERE id<>?').all(options.organizationId).length)throw new Error('Legacy identity database contains a foreign organization');
    for(const table of ['opencrawlIdentityState','member','invitation'])if(names.includes(table)&&source.prepare(`SELECT 1 FROM ${identifier(table)} WHERE organizationId<>? LIMIT 1`).get(options.organizationId))throw new Error('Legacy identity contains a foreign organization binding');
    const remaining=tables.filter(table=>names.includes(table.name)),selected:ImportTable[]=[];
    // Plugin tables intentionally share Infinity ordering. Resolve real foreign
    // keys instead of alphabetically inserting grants before their clients.
    while(remaining.length){
      const index=remaining.findIndex(table=>Object.values(schema[table.name]?.fields??{}).every(field=>!field.references||!remaining.some(other=>other.name===field.references!.model)));
      if(index<0)throw new Error('Identity schema contains cyclic migration dependencies');
      selected.push(remaining.splice(index,1)[0]!);
    }
    const inputs=selected.map(table=>{const columns=sourceColumns(source,table);return {table,columns,source:digestRows(sourceRows(source,table,columns))};});
    if(options.mode==='migrate')await ensureIdentitySchema(options);
    return await options.database.transaction(async client=>{
      if(options.mode==='migrate')await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[options.database.identitySchema+':import']);
      for(const table of tables.filter(table=>!names.includes(table.name))){
        const qualified=identifier(options.database.identitySchema)+'.'+identifier(table.name);
        if((await client.query('SELECT to_regclass($1) AS name',[qualified])).rows[0]?.name&&Number((await client.query(`SELECT count(*) AS count FROM ${qualified}`)).rows[0]?.count))throw new Error('Target identity contains records absent from the legacy source');
      }
      const receipts:ImportReceipt[]=[];
      for(const input of inputs){
        if(options.mode==='migrate')await copyTable(source,client,options.database.identitySchema,input.table,input.columns);
        const target=await targetDigest(client,options.database.identitySchema,input.table,input.columns),matches=target?.rows===input.source.rows&&target.sha256===input.source.sha256;
        if(options.mode!=='check'&&!matches)throw new Error('Identity migration verification failed for '+input.table.name);
        receipts.push({table:input.table.name,source:input.source,target,matches});
      }
      return {domain:'identity' as const,mode:options.mode,organizationId:options.organizationId,tables:receipts,verified:receipts.every(receipt=>receipt.matches)};
    });
  }finally{source.close();}
}
