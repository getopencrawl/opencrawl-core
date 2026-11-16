import type {RealmOptions,SearchRealm,SearchCollection} from './types.mjs';
import {createSqliteEngine} from './sqlite-engine.mjs';
import {sqliteExecutor,sqliteSearchDeadline} from './sqlite-executor.mjs';
import type {SqliteCommand,CollectionOperation} from './sqlite-protocol.mjs';
export {sqlitePath} from './sqlite-engine.mjs';

/** SQL, lock waits and aggregation loops run outside the API event loop. The
 * engine instance here supplies pure scope/encoding helpers; no DB is opened. */
export function createSqliteRealm(options:RealmOptions):SearchRealm {
 const local=createSqliteEngine(options);
 const realm={endpoint:options.endpoint,index:local.index,tenantId:local.tenantId};
 function submit<T>(command:SqliteCommand,timeout?:number):Promise<T>{return sqliteExecutor().run<T>(command,timeout);}
 return {...local,
  ensureIndex:()=>submit({realm,operation:'ensureIndex',args:[]}),
  async refresh(principal){local.scope(principal);return submit({realm,operation:'refresh',args:[principal]});},
  collection(corpus){
   const helpers=local.collection(corpus);
   const call=<K extends CollectionOperation>(operation:K,args:Parameters<SearchCollection[K]>,timeout?:number):ReturnType<SearchCollection[K]>=>{
    try{local.scope(args[0]);}catch(error){throw Object.assign(error as object,{writeOutcome:'not-applied'});}
    return submit({realm,corpus,operation,args} as SqliteCommand,timeout) as ReturnType<SearchCollection[K]>;
   };
   return {...helpers,
    async search(...args){local.scope(args[0]);return call('search',args,sqliteSearchDeadline(args[1].timeout));},
    async mget(...args){return call('mget',args);},async bulk(...args){return call('bulk',args);},
    async delete(...args){return call('delete',args);},async byQuery(...args){return call('byQuery',args);},
    async update(...args){return call('update',args);},
   };
  },
 };
}
