import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ApplicationDatabase,ApplicationTransaction} from './postgres.mjs';
import type {ObjectStore,StoreVersion} from '../sessions/types.mjs';
import {createControls,type ResourceControls} from '../sessions/controls.mjs';
import {digest} from '../sessions/event-identity.mjs';
import {sourceKey,readRetainedControl,scanResourceControls} from './resource-control-inventory.mjs';
import {authorityTable,controlsTable,writesTable,match,parameters,postgresControlRows,controlIdentities,
  keepsDeletion,readResourceControlSeal,prepareControlTables,copyControl,retainedReceipt,checkedControl,type ControlIdentity,type ControlReceipt} from './resource-control-rows.mjs';

export type {ControlReceipt};
type Query=Pick<ApplicationTransaction,'query'>;

/** Object-backed until one source-bound transaction commits the verified import.
 * Only the final delta and seal hold the writer lock. Reads remain available. */
export function createResourceControlState(database:ApplicationDatabase,store:ObjectStore,prefix:string) {
  const {namespace:ns,sourceIdentity:source}=database;
  if(!source || !store.bucket || source.bucket!==store.bucket || source.prefix!==prefix)throw Error('Resource control source binding differs');
  const ids=controlIdentities(source.organizationId),sql=postgresControlRows(database,ids),objects=createControls({store,prefix});
  const lock=JSON.stringify(['resource-control-writers',ns]),operator=JSON.stringify(['resource-control-migration',ns]);
  let preparing:Promise<void>|undefined,switched=false;
  const seal=(db:Query)=>readResourceControlSeal(db,ns,source);
  function ready(){
    preparing??=database.transaction(async db=>{
      await prepareControlTables(db);
      await db.query('INSERT INTO '+authorityTable+'(namespace,source) VALUES($1,$2) ON CONFLICT DO NOTHING',[ns,source]);
      switched=Boolean(await seal(db));
    }).catch(error=>{preparing=undefined;throw error;});
    return preparing;
  }
  async function active(){await ready();if(!switched && await seal(database.pool))switched=true;return switched;}
  async function pending(db:Query) {
    return Number((await db.query('SELECT count(*) FROM '+writesTable+' WHERE namespace=$1 AND NOT settled',[ns])).rows[0].count);
  }
  async function status(){
    await ready();const receipt=await seal(database.pool);
    return {backend:receipt?'postgres' as const:'objects' as const,receipt,pendingSourceWrites:await pending(database.pool)};
  }
  async function read<T>(legacy:()=>Promise<T>,native:()=>Promise<T>){
    if(await active())return native();
    let value:T;
    try{value=await legacy();}catch(error){if(await active())return native();throw error;}
    return await active()?native():value;
  }
  const controls:ResourceControls={
    read(owner,kind,harness,name){ids.resource(owner,kind,harness,name);return read(()=>objects.read(owner,kind,harness,name),()=>sql.read(owner,kind,harness,name));},
    readSource(s){ids.source(s);return read(()=>objects.readSource(s),()=>sql.readSource(s));},
    list(owner,kind,harness){ids.resource(owner,kind,harness,'x');return read(()=>objects.list(owner,kind,harness),()=>sql.list(owner,kind,harness));},
    pendingDeletions(owner){ids.owner(owner);return read(()=>objects.pendingDeletions(owner),()=>sql.pendingDeletions(owner));},
    async update(owner,kind,harness,name,change){
      const key=ids.resource(owner,kind,harness,name),native=()=>sql.update(owner,kind,harness,name,change);
      if(await active())return native();
      const sealed=Error('Resource control authority switched');
      const guarded=createControls({prefix,store:{...store,async compareAndSet(path,version,bytes,options){
        if(path!==sourceKey(prefix,key))throw Error('Resource control source key differs');
        checkedControl(Buffer.from(bytes),key);
        const operation=randomUUID();
        const admitted=await database.transaction(async db=>{
          await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
          await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[lock]);
          if(await seal(db))return false;
          await db.query(`INSERT INTO ${writesTable}(namespace,owner,kind,harness,name_hash,operation,expected_version,intended)
            VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,[...parameters(ns,key),operation,JSON.stringify(version),Buffer.from(bytes)]);
          return true;
        });
        if(!admitted){switched=true;throw sealed;}
        let settled=false;
        try{const result=await store.compareAndSet(path,version,bytes,options);settled=true;return result;}
        catch(error){settled=(error as {writeOutcome?:string})?.writeOutcome==='not-applied';throw error;}
        finally{if(settled)await database.pool.query('UPDATE '+writesTable+' SET settled=true WHERE namespace=$1 AND operation=$2',[ns,operation]);}
      }}});
      try{return await guarded.update(owner,kind,harness,name,change);}
      // Only a refused admission proves this attempt never dispatched a source CAS.
      // An ambiguous completion must not replay over a newer private or deleted row.
      catch(error){if(error===sealed)return native();throw error;}
    },
  };

  async function exclusive<T>(run:(db:ApplicationTransaction)=>Promise<T>) {
    await ready();
    return database.transaction(async db=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const {rows:[row]}=await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[operator]);
      if(!row.locked)throw Error('Another resource control operation is running');
      return run(db);
    });
  }
  async function activate(attest:(candidate?:ControlReceipt)=>Promise<void>){
    const receipt=await exclusive(async db=>{
      const saved=await seal(db);if(saved)return saved;
      if(typeof attest!=='function')throw Error('Resource control fleet attestation required');
      await attest();
      // The source scan is strongly consistent after each previously settled CAS.
      // Track only writes still open here and new writes during discovery.
      await db.query('DELETE FROM '+writesTable+' WHERE namespace=$1 AND settled',[ns]);
      if((await db.query('SELECT 1 FROM '+controlsTable+' WHERE namespace=$1 LIMIT 1',[ns])).rowCount)throw Error('Resource control target must be empty');
      await scanResourceControls(store,prefix,source!.organizationId,async items=>{
        for(const item of items)await copyControl(db,ns,item);
      });
      // Every participating CAS commits its intent before dispatch. Once this
      // lock is held no new intent can appear, including one for a new owner.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
      if(await pending(db))throw Error('Resource control write is in flight or uncertain');
      const dirty=await db.query(`SELECT DISTINCT owner,kind,harness,name_hash FROM ${writesTable} WHERE namespace=$1`,[ns]);
      for(const {owner,kind,harness,name_hash} of dirty.rows){
        const key=ids.key(owner,kind,harness,name_hash),current=await readRetainedControl(store,prefix,key);
        if(current)await copyControl(db,ns,current);
        else if((await db.query('SELECT 1 FROM '+controlsTable+' WHERE '+match,parameters(ns,key))).rowCount)
          throw Error('Copied resource control disappeared');
      }
      const receipt=await retainedReceipt(db,ns);
      await attest(receipt);
      await db.query('UPDATE '+authorityTable+' SET receipt=$2,activated_at=clock_timestamp() WHERE namespace=$1',[ns,receipt]);
      await db.query('DELETE FROM '+writesTable+' WHERE namespace=$1',[ns]);
      return receipt;
    });
    switched=true;return receipt;
  }
  async function verify() {
    return exclusive(async db=>{
      const saved=await seal(db);if(!saved)throw Error('PostgreSQL resource controls are not active');
      const counts={sessions:0,memories:0};
      await scanResourceControls(store,prefix,source!.organizationId,async items=>{
        for(const item of items){
          const {rows:[row]}=await db.query('SELECT control,revision,source_version,source_hash FROM '+controlsTable+' WHERE '+match,parameters(ns,item));
          if(!row || row.source_hash!==item.hash || row.source_version!==item.version ||
             Number(row.revision)===0 && !isDeepStrictEqual(row.control,item.control) ||
             !keepsDeletion(item.kind,item.control,row.control))throw Error('Resource control verification differs');
          counts[item.kind]++;
        }
      });
      if(saved.sessions!==counts.sessions || saved.memories!==counts.memories || !isDeepStrictEqual(saved,await retainedReceipt(db,ns)))throw Error('Resource control verification differs');
      return saved;
    });
  }
  /** Exact recovery for a durable intent left by an interrupted CAS. The
   * operator checks provider terminality and drains writers before replaying.
   * A superseding write is retained only if it honors the requested restriction. */
  async function reconcile(operation:string,attest:()=>Promise<{writersDrained:true;requestTerminal:true}>) {
    if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operation))throw Error('Exact resource control operation required');
    return exclusive(async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
      if(await seal(db))throw Error('Resource control source recovery is closed');
      const {rows:[row]}=await db.query('SELECT * FROM '+writesTable+' WHERE namespace=$1 AND operation=$2 AND NOT settled FOR UPDATE',[ns,operation]);
      if(!row)return false;
      const proof=await attest();if(proof?.writersDrained!==true||proof.requestTerminal!==true)throw Error('Resource control write evidence required');
      const key=ids.key(row.owner,row.kind,row.harness,row.name_hash),target=checkedControl(row.intended,key);
      const actual=()=>readRetainedControl(store,prefix,key);
      let current=await actual();
      if(current?.hash!==digest(row.intended) && (current?.version??null)===row.expected_version) {
        await store.compareAndSet(sourceKey(prefix,key),row.expected_version as StoreVersion|null,row.intended);
        current=await actual();
      }
      if(!current)throw Error('Superseding resource control requires reconciliation');
      // Only a session tombstone hides every future version. A memory cutoff
      // does not replace a privacy setting for files modified after that date.
      const hidden=key.kind==='sessions' && current.control.deletedAt!==null;
      const visibilityKept=current.control.visibility===target.visibility &&
        (target.visibilitySource!=='manual' || current.control.visibilitySource==='manual');
      if(!keepsDeletion(key.kind,target,current.control) || !hidden && !visibilityKept)
        throw Error('Superseding resource control requires reconciliation');
      await db.query('UPDATE '+writesTable+' SET settled=true WHERE namespace=$1 AND operation=$2',[ns,operation]);
      return true;
    });
  }
  return {controls,ready,status,activate,verify,reconcile};
}
