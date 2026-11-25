import {createHash} from 'node:crypto';
import {credentialDigest,credentialReadLimit,credentialSource,checkedCredentialRecord,type CredentialRecord} from '../sessions/credentials.mjs';
import {sessionScope,digest} from '../sessions/event-identity.mjs';
import type {ObjectStore,StoreVersion} from '../sessions/types.mjs';

import {credentialFamilies,type CredentialFamily} from './credential-records.mjs';
export {credentialFamilies,type CredentialFamily} from './credential-records.mjs';
export function credentialPrefix(root:string,family:CredentialFamily){return family==='capture'?root:root+'/_agent-access';}
export type CredentialImportReceipt={capture:{records:number;generations:number};agent:{records:number;generations:number};sha256:string};
type SourceItem={family:CredentialFamily;sourceHash:string;owner:string} & (
  {kind:'record';id:string;record:CredentialRecord} | {kind:'generation';generation:string;version:StoreVersion});
const ownerPath=/^tenants\/([a-f0-9]{64})\/users\/[a-f0-9]{64}$/;

export async function credentialInventory(store:ObjectStore,root:string,organizationId:string|null,
  visit:(items:SourceItem[])=>Promise<void>):Promise<CredentialImportReceipt> {
  const result={capture:{records:0,generations:0},agent:{records:0,generations:0},sha256:''};
  const inventory=createHash('sha256'),tenantHash=organizationId?digest(organizationId):undefined;
  for(const family of credentialFamilies) for(const kind of ['record','generation'] as const){
    const folder=credentialPrefix(root,family)+(kind==='record'?'/_credentials/':'/_credential-generations/');
    const cursors=new Set<string>();let previous='',cursor:string|null=null;
    do{
      const page=await credentialSource(()=>store.listPage(folder,{continuationToken:cursor,maxKeys:128,requireComplete:true}));
      if(page.prefixes?.length)throw Error('Incomplete credential source listing');
      const paths=page.keys.filter(key=>key!==folder);
      for(let n=0;n<paths.length;n+=8){
        const items=await Promise.all(paths.slice(n,n+8).map(async (path):Promise<SourceItem>=>{
          if(typeof path!=='string' || !path.startsWith(folder) || !path.endsWith('.json'))throw Error('Unexpected retained credential key');
          const id=path.slice(folder.length,-5);
          if(kind==='record'?!credentialDigest(id):!ownerPath.test(id))throw Error('Unexpected retained credential key');
          const {data,version}=await credentialSource(()=>store.readVersion(path,{maxBytes:kind==='record'?credentialReadLimit:1024}));
          if(!data || version===null || !(typeof version==='string'&&version.length>0 || typeof version==='number'&&Number.isFinite(version)))throw Error('Credential source or version unavailable');
          let value:unknown;try{value=JSON.parse(data.toString());}catch{throw Error('Invalid retained credential document');}
          const sourceHash=digest(JSON.stringify([version,digest(data)]));
          if(kind==='record'){
            const record=checkedCredentialRecord(value,id);
            if(organizationId && record.principal.tenantId!==organizationId)throw Error('Credential is outside configured organization');
            return {family,kind,id,record,owner:sessionScope(record.principal),sourceHash};
          }
          if(tenantHash && !id.startsWith('tenants/'+tenantHash+'/users/'))throw Error('Credential generation is outside configured organization');
          const marker=value as {generation?:unknown}|null;
          if(!marker || Object.keys(marker).length!==1 || !credentialDigest(marker.generation))throw Error('Invalid retained credential generation');
          return {family,kind,owner:id,generation:marker.generation,version,sourceHash};
        }));
        for(const item of items){
          const id=item.kind==='record'?item.id:item.owner;
          if(previous && previous>=id)throw Error('Unordered or repeated credential source key');
          previous=id;inventory.update(JSON.stringify([family,kind,id,item.sourceHash])+'\n');
          if(kind==='record')result[family].records++;else result[family].generations++;
        }
        await visit(items);
      }
      cursor=page.nextToken;
      if(cursor!==null){if(!cursor || cursors.has(cursor))throw Error('Invalid credential source cursor');cursors.add(cursor);}
    }while(cursor!==null);
  }
  result.sha256=inventory.digest('hex');return result;
}
