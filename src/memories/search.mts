import {lexicalQuery} from '../search/lexical.mjs';
import type {Principal,ObjectStore} from '../sessions/types.mjs';
import type {StoredMemorySnapshot} from './types.mjs';
import type {RealmOptions, SearchInput, DocumentItem, Passage} from '../search/types.mjs';
import {createRealmResolver,realmField} from '../search/realm.mjs';
import {digest,sessionScope} from '../sessions/event-identity.mjs';
import {visibleTo,createControls} from '../sessions/controls.mjs';
import type {ResourceControl} from '../sessions/controls.mjs';
import {searchFilters,searchSort} from '../search/controls.mjs';
import {passages,PASSAGE_VERSION} from '../search/passages.mjs';
import {activeMemoryProjectionFilter,memoryProjectionId,memoryPassageId,MEMORY_HEAD_FIELDS} from './projection.mjs';
import {authorizedMemoryDocuments} from './access.mjs';

const f=(field: string)=>realmField('memory',field);
function fail(status: number,message: string): never {throw Object.assign(new Error(message),{status});}
export function createMemorySearch(options: RealmOptions & {store?:ObjectStore;prefix?:string}) {
  const resolve=createRealmResolver(options);
  const authoritativeControls=options.store&&options.prefix?createControls({store:options.store,prefix:options.prefix}):null;
  async function heads(principal: Principal) {
    const result=await resolve(principal).collection('memory').search(principal,{size:10000,track_total_hits:true,
      query:{term:{[f('kind')]:'snapshot'}},_source:MEMORY_HEAD_FIELDS});
    if(result.hits.total?.relation!=='eq'||result.hits.total.value>10000)throw new Error('Memory inventory exceeds search window');
    return result.hits.hits.map(h=>h._source);
  }
  return {
    async putSnapshot(snapshot: StoredMemorySnapshot,principal: Principal,sourceKey: string,{controls=new Map()}: {controls?: Map<string, ResourceControl>}={}) {
      sessionScope(principal);
      if(snapshot.owner.tenantId!==principal.tenantId||snapshot.owner.userId!==principal.userId)fail(403,'Memory scope mismatch');
      const realm=resolve(principal);await realm.ensureIndex();
      const collection=realm.collection('memory');
      const projectionId=memoryProjectionId(snapshot.snapshotId);
      const common={tenantId:principal.tenantId,userId:principal.userId,installationId:snapshot.installationId,harness:snapshot.harness,projectionId,passageVersion:PASSAGE_VERSION,
        host:snapshot.host,generation:snapshot.generation,snapshotId:snapshot.snapshotId,receivedAt:snapshot.receivedAt,sourceKey};
      let batch: DocumentItem[]=[],bytes=0,count=0;
      for(const file of snapshot.files) {
        // A deleted memory stays deleted until the agent writes a newer version.
        const control=controls.get(digest(file.path));
        if(control?.deletedAt&&!(Date.parse(file.modifiedAt)>Date.parse(control.deletedAt)))continue;
        const chunks=passages(file.text);
        const sourceSessionId=/^(?:thread_id|originSessionId):\s*["']?([A-Za-z0-9_-]+)/m.exec(file.text)?.[1]??null;
        for(let chunk=0;chunk<chunks.length;chunk++) {
          const item={id:memoryPassageId(principal,snapshot.snapshotId,file.path,chunk,projectionId),document:{...common,kind:'passage',
            path:file.path,project:file.project,modifiedAt:file.modifiedAt,sourceSessionId,chunk,title:`${snapshot.harness} memory: ${file.path}`,text:chunks[chunk]!.text,
            passageVersion:PASSAGE_VERSION,textStart:chunks[chunk]!.start,textEnd:chunks[chunk]!.end,chunkCount:chunks.length,private:control?.visibility==='private'}};
          const size=Buffer.byteLength(JSON.stringify(item));
          if(bytes+size>3*1024*1024){await collection.bulk(principal,batch);batch=[];bytes=0;}
          batch.push(item);bytes+=size;count++;
        }
      }
      if(batch.length)await collection.bulk(principal,batch);
      // Publish only after every new passage is search-visible. A single atomic
      // head update activates the complete snapshot and hides all removed files.
      const refreshed=await realm.refresh(principal);
      if(refreshed?._shards?.failed!==0)throw new Error('Memory snapshot refresh incomplete');
      const headId=digest(JSON.stringify([sessionScope(principal),snapshot.harness,snapshot.installationId,'head']));
      await collection.bulk(principal,[{id:headId,document:{...common,kind:'snapshot'},policy:'memory-head'}],{refresh:true});
      return count;
    },
    async search(principal: Principal,{query='',limit=20,match='all',id,filters,order}: SearchInput={}) {
      sessionScope(principal);
      if(principal.captureAccess!==undefined)fail(403,'Capture credentials cannot read memories');
      if(!authoritativeControls)fail(503,'Memory reads require authoritative resource controls');
      if(typeof query!=='string'||query.length>4000||!Number.isInteger(limit)||limit<1||limit>100||!['all','any','phrase'].includes(match)||
        id!==undefined&&(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))fail(400,'Invalid memory search');
      const active=await heads(principal);
      if(!active.length)return {total:0,hits:[],truncated:false};
      const result=await resolve(principal).collection('memory').search(principal,{size:limit,track_total_hits:true,
        query:{bool:{filter:[{term:{[f('kind')]:'passage'}},activeMemoryProjectionFilter(active),visibleTo('memory',principal),...searchFilters('memory',filters),...(id?[{term:{id}}]:[])],
          must:[lexicalQuery(query,match)]}},
        sort:[...searchSort('memory',order),...(query?['_score',{[f('modifiedAt')]:'desc'},{id:'asc'}]:[{[f('modifiedAt')]:'desc'},{id:'asc'}])]});
      const candidates=result.hits.hits.map(h=>({id:h._id,score:h._score,...h._source} as Passage));
      const hits=await authorizedMemoryDocuments(authoritativeControls,principal,candidates),filtered=hits.length!==candidates.length;
      return {total:filtered?hits.length:result.hits.total.value,truncated:filtered||result.hits.total.value>result.hits.hits.length,hits};
    },
  };
}
