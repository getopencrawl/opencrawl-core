import {Pool, type PoolClient, type PoolConfig} from 'pg';
export type {PoolClient as ApplicationTransaction} from 'pg';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ApplicationSourceIdentity} from './settings.mjs';

/** One operator-owned application database. Temporal keeps its own database. */
export interface ApplicationDatabase {
  readonly pool: Pool;
  readonly identityPool: Pool;
  readonly namespace: string;
  readonly identitySchema: string;
  readonly sourceIdentity?:ApplicationSourceIdentity;
  readonly onlineTargetId?:string;
  ready(): Promise<void>;
  transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Called under the owning schema advisory lock. Validate the existing index
 * without taking CREATE INDEX's ShareLock on every runtime startup. */
export async function ensureByteOrderIndex(client:PoolClient,table:string,index:string,columns:readonly string[]){
  if(!columns.length||![table,index,...columns].every(value=>/^[a-z_]+$/.test(value)))throw new Error('Invalid byte-order index definition');
  const {rows}=await client.query(`SELECT idx.relkind,i.indisvalid,i.indisready,i.indislive,
    i.indrelid=t.oid AS owns_table,i.indpred IS NULL AND i.indexprs IS NULL AS plain,
    i.indnkeyatts,i.indnatts,am.amname,i.indcollation::oid[] AS collations,i.indoption::smallint[] AS options,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(n,pos) LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.n ORDER BY pos) AS columns,
    ARRAY(SELECT a.attcollation FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(n,pos) LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.n ORDER BY pos) AS column_collations,
    'pg_catalog."C"'::regcollation::oid AS c_collation,
    i.indclass::oid[] <@ ARRAY(SELECT oid FROM pg_opclass WHERE opcname='text_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=idx.relam) AS text_ops
    FROM pg_class t JOIN pg_class idx ON idx.relnamespace=t.relnamespace AND idx.relname=$2
    LEFT JOIN pg_index i ON i.indexrelid=idx.oid LEFT JOIN pg_am am ON am.oid=idx.relam
    WHERE t.oid=to_regclass($1)`,[table,index]);
  if(!rows.length){
    await client.query(`CREATE INDEX ${index} ON ${table}(${columns.map((name,i)=>name+(i===columns.length-1?' COLLATE "C"':'')).join(',')})`);return;
  }
  const found=rows[0];
  if(found.relkind!=='i'||!found.indisvalid||!found.indisready||!found.indislive||!found.owns_table||!found.plain||!found.text_ops||found.amname!=='btree'||found.indnkeyatts!==columns.length||found.indnatts!==columns.length||!isDeepStrictEqual(found.columns,columns)||found.options.some((value:number)=>value!==0)||found.collations.some((value:number,i:number)=>Number(value)!==Number(i===columns.length-1?found.c_collation:found.column_collations[i])))
    throw new Error('Existing migration byte-order index is incompatible: '+index);
}

/** Fixed owning-site index declarations, called under the owning schema lock.
 * Existing indexes are checked in catalogs; CREATE INDEX, even IF NOT EXISTS,
 * takes a writer-conflicting lock and belongs only to a missing-index upgrade. */
export async function ensureSchemaIndex(client:PoolClient,{table,name,keys,method='btree',predicate,jsonKey}:{table:string;name:string;keys:readonly string[];method?:'btree'|'gin';predicate?:{column:string;equals:string;notNull?:string};jsonKey?:{column:string;key:string}}){
  const identifier=/^[a-z_]+$/;
  if(jsonKey&&(!identifier.test(jsonKey.column)||!/^[-a-zA-Z]+$/.test(jsonKey.key)||predicate))throw new Error('Invalid schema JSON index predicate');
  if(!identifier.test(table)||!identifier.test(name)||!['btree','gin'].includes(method)||!keys.length||keys.length>8||predicate&&(!identifier.test(predicate.column)||!/^[-a-z]+$/.test(predicate.equals)||predicate.notNull&&!identifier.test(predicate.notNull)))throw new Error('Invalid schema index declaration');
  const relation=(await client.query('SELECT oid,relnamespace::regnamespace::text AS schema FROM pg_class WHERE oid=to_regclass($1) AND relkind=\'r\'',[table])).rows[0];
  if(!relation)throw new Error('Missing schema index table: '+table);
  const attributes=(await client.query('SELECT attname,atttypid::regtype::text AS type,attcollation::int AS collation FROM pg_attribute WHERE attrelid=$1 AND attnum>0 AND NOT attisdropped',[relation.oid])).rows;
  const columns=new Map<string,{type:string;collation:number}>(attributes.map(row=>[row.attname,row]));
  const classes:Record<string,string>=method==='btree'?{text:'text_ops',bigint:'int8_ops',uuid:'uuid_ops','timestamp with time zone':'timestamptz_ops'}:{jsonb:'jsonb_ops',tsvector:'tsvector_ops'};
  const rendered:string[]=[],options:number[]=[],collations:number[]=[],opclasses:string[]=[];
  for(const key of keys){
    const plain=/^([a-z_]+)( DESC)?$/.exec(key),lower=/^lower\(([a-z_]+)\)$/.exec(key),json=/^\(\(([a-z_]+) -> '([-a-z]+)'::text\)\)$/.exec(key);
    const jsonInteger=/^\(\(\(([a-z_]+) ->> '([a-zA-Z]+)'::text\)\)::bigint\)$/.exec(key);
    const column=plain?.[1]??lower?.[1]??json?.[1]??jsonInteger?.[1],attribute=column?columns.get(column):undefined;
    if(!attribute||lower&&attribute.type!=='text'||(json||jsonInteger)&&attribute.type!=='jsonb'||method==='gin'&&plain?.[2])throw new Error('Unsupported schema index key: '+key);
    const type=jsonInteger?'bigint':lower?'text':json?'jsonb':attribute.type,opclass=classes[type];
    if(!opclass)throw new Error('Unsupported schema index type: '+type);
    rendered.push(plain?plain[1]!:key);options.push(plain?.[2]?3:0);collations.push(json||jsonInteger?0:attribute.collation);opclasses.push(opclass);
  }
  if(predicate&&(!columns.has(predicate.column)||columns.get(predicate.column)?.type!=='text'||predicate.notNull&&!columns.has(predicate.notNull)))throw new Error('Invalid schema index predicate');
  if(jsonKey&&columns.get(jsonKey.column)?.type!=='jsonb')throw new Error('Invalid schema JSON index column');
  const condition=jsonKey?`(${jsonKey.column} ? '${jsonKey.key}'::text)`:predicate?predicate.notNull?`((${predicate.column} = '${predicate.equals}'::text) AND (${predicate.notNull} IS NOT NULL))`:`(${predicate.column} = '${predicate.equals}'::text)`:null;
  const {rows}=await client.query(`SELECT idx.relkind,i.indisvalid,i.indisready,i.indislive,i.indisunique,i.indisexclusion,i.indrelid=$1 AS owns_table,
    i.indnkeyatts,i.indnatts,am.amname,i.indcollation::oid[] AS collations,i.indoption::smallint[] AS options,
    ARRAY(SELECT pg_get_indexdef(i.indexrelid,n,false) FROM generate_series(1,i.indnkeyatts)n) AS keys,
    pg_get_expr(i.indpred,i.indrelid,false) AS predicate,
    ARRAY(SELECT opc.opcname::text FROM unnest(i.indclass::oid[]) WITH ORDINALITY k(n,pos) JOIN pg_opclass opc ON opc.oid=k.n ORDER BY pos) AS opclasses,
    NOT EXISTS(SELECT 1 FROM unnest(i.indclass::oid[]) k(n) JOIN pg_opclass opc ON opc.oid=k.n WHERE NOT opc.opcdefault OR opc.opcnamespace<>'pg_catalog'::regnamespace OR opc.opcmethod<>idx.relam) AS default_classes,
    NOT EXISTS(SELECT 1 FROM pg_depend d LEFT JOIN pg_proc p ON d.refclassid='pg_proc'::regclass AND p.oid=d.refobjid LEFT JOIN pg_operator o ON d.refclassid='pg_operator'::regclass AND o.oid=d.refobjid WHERE d.classid='pg_class'::regclass AND d.objid=idx.oid AND (p.pronamespace<>'pg_catalog'::regnamespace OR o.oprnamespace<>'pg_catalog'::regnamespace)) AS builtin_expressions
    FROM pg_class idx LEFT JOIN pg_index i ON i.indexrelid=idx.oid LEFT JOIN pg_am am ON am.oid=idx.relam
    WHERE idx.relnamespace=(SELECT relnamespace FROM pg_class WHERE oid=$1) AND idx.relname=$2`,[relation.oid,name]);
  if(!rows.length){
    await client.query(`CREATE INDEX ${name} ON ${relation.schema}.${table} USING ${method}(${keys.join(',')})${condition?' WHERE '+condition:''}`);
    // Also validate one-time creation: an explicitly reordered search_path must
    // not substitute a same-named operator or function in an expression index.
    await ensureSchemaIndex(client,{table,name,keys,method,...(predicate?{predicate}:{}),...(jsonKey?{jsonKey}:{})});return;
  }
  const found=rows[0];
  if(found.relkind!=='i'||!found.indisvalid||!found.indisready||!found.indislive||found.indisunique||found.indisexclusion||!found.owns_table||!found.default_classes||!found.builtin_expressions||found.amname!==method||found.indnkeyatts!==keys.length||found.indnatts!==keys.length||!isDeepStrictEqual(found.keys,rendered)||!isDeepStrictEqual(found.options,options)||!isDeepStrictEqual(found.collations.map(Number),collations)||!isDeepStrictEqual(found.opclasses,opclasses)||found.predicate!==condition)throw new Error('Existing schema index is incompatible: '+name);
}

export function createApplicationDatabase({namespace,sourceIdentity,onlineTargetId, ...config}: PoolConfig & {namespace: string;sourceIdentity?:ApplicationSourceIdentity;onlineTargetId?:string}): ApplicationDatabase {
  if (!namespace || namespace.length > 2048 || namespace.includes('\0')) throw new Error('A stable application-state namespace is required');
  if(onlineTargetId!==undefined&&!/^[a-f0-9]{64}$/.test(onlineTargetId))throw new Error('An exact online target identity is required');
  const identitySchema = 'oc_auth_' + createHash('sha256').update(namespace).digest('hex').slice(0, 24);
  const defaults: PoolConfig = {max: 8, connectionTimeoutMillis: 10000, ...config};
  const pool = new Pool(defaults);
  // Better Auth's pinned native PostgreSQL adapter uses unqualified table names.
  // The identifier is derived locally, never interpolated from operator input.
  const identityPool = new Pool({...defaults, max: 4, options: `${config.options || ''} -c search_path=${identitySchema}`.trim()});
  for (const current of [pool, identityPool]) current.on('error', () => {});
  let preparing: Promise<void> | undefined;
  let closed = false;
  async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    if (closed) throw new Error('Application database is closed');
    const client = await pool.connect();
    let destroy = false;
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {await client.query('ROLLBACK');} catch {destroy = true;}
      throw error;
    } finally {client.release(destroy);}
  }
  return {
    pool, identityPool, namespace, identitySchema,sourceIdentity,onlineTargetId, transaction,
    async ready() {
      if (closed) throw new Error('Application database is closed');
      preparing ??= transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:application:schema', 0))");
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${identitySchema}`);
        await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_application_schema (
          singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL);
          INSERT INTO opencrawl_application_schema(singleton, version) VALUES(true, 1) ON CONFLICT DO NOTHING;
          CREATE TABLE IF NOT EXISTS opencrawl_application_installations (
            namespace text PRIMARY KEY, source_identity jsonb NOT NULL, migration_id uuid NOT NULL,
            state text NOT NULL CHECK(state IN ('importing','ready')), created_at timestamptz NOT NULL DEFAULT now(),
            verified_at timestamptz, source_manifest_hash text,inventory_complete boolean NOT NULL DEFAULT false,
            CHECK(state <> 'ready' OR verified_at IS NOT NULL));
          CREATE TABLE IF NOT EXISTS opencrawl_application_migration_sources (
            namespace text NOT NULL REFERENCES opencrawl_application_installations(namespace),
            source_key text NOT NULL,domain text NOT NULL,source_version text,source_hash text NOT NULL,
            source_bytes bigint NOT NULL CHECK(source_bytes>=0),PRIMARY KEY(namespace,source_key));
          CREATE TABLE IF NOT EXISTS opencrawl_application_migrations (
            namespace text NOT NULL REFERENCES opencrawl_application_installations(namespace),
            domain text NOT NULL, source_key text NOT NULL, source_version text, source_hash text NOT NULL,
            target_hash text NOT NULL, imported_rows bigint NOT NULL CHECK(imported_rows >= 0),
            completed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(namespace, domain, source_key))`);
        const inventoryColumn=(await client.query("SELECT atttypid='boolean'::regtype AS type,attnotnull,attgenerated,attidentity,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='opencrawl_application_installations'::regclass AND a.attname='inventory_complete' AND NOT a.attisdropped")).rows[0];
        if(!inventoryColumn)await client.query('ALTER TABLE opencrawl_application_installations ADD COLUMN inventory_complete boolean NOT NULL DEFAULT false');
        else if(!inventoryColumn.type||!inventoryColumn.attnotnull||inventoryColumn.attgenerated!==''||inventoryColumn.attidentity!==''||inventoryColumn.default_value!=='false')throw new Error('Unsupported application inventory column');
        // Even CREATE INDEX IF NOT EXISTS takes a writer-conflicting table lock.
        // The schema advisory lock serializes this one-time offline upgrade.
        await ensureByteOrderIndex(client,'opencrawl_application_migration_sources','opencrawl_application_sources_byte_order',['namespace','source_key']);
        const result = await client.query('SELECT version FROM opencrawl_application_schema WHERE singleton');
        if (result.rows[0]?.version !== 1) throw new Error('Unsupported application database schema; use the supported upgrade');
      }).catch(error => {preparing = undefined; throw error;});
      await preparing;
    },
    async close() {if (closed) return; closed = true; await Promise.all([pool.end(), identityPool.end()]);},
  };
}
