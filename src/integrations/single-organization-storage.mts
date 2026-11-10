import {landingDestinationConfiguration} from './destination.mjs';
import {Readable} from 'node:stream';
import type {createObjectStore} from '../sessions/s3-store.mjs';
import type {IntegrationStorage,LandingDestination} from './ports.mjs';
import type {IntegrationRecord} from './types.mjs';
/** An existing bucket belongs to this installation; no bucket or tenant creation. */
export function singleOrganizationStorage(organizationId:string,store:ReturnType<typeof createObjectStore>):IntegrationStorage {
  if(!/^org_[A-Za-z0-9]+$/.test(organizationId))throw new Error('Configure one organization');
  const deny=()=>{throw Object.assign(new Error('Storage scope denied'),{status:403});};
  const check=(bucket:string,key:string)=>{
    if(bucket!==store.bucket||!key||key.split('/').some(p=>p==='.'||p==='..')||!(key.startsWith('raw/v1/source=')||/^_opencrawl\/counts\/connection=int_[a-f0-9]{26}\.json\.gz$/.test(key)))deny();
  };
  return {
    async get(id){return id===organizationId?store.bucket:null;},
    async read(bucket,key){check(bucket,key);const body=await store.get(key,{maxBytes:32*1024*1024});if(!body)throw Object.assign(new Error('Object not found'),{status:404});return body;},
    async write(bucket,key,body){check(bucket,key);await store.put(key,body);},
    async stream(bucket,key){check(bucket,key);return Readable.from(store.read(key));},
    async list(bucket,prefix){check(bucket,prefix);return (await store.list(prefix)).keys.map(key=>({key,size:0}));},
    async deletePrefix(bucket,prefix){
      check(bucket,prefix);
      if(!/^raw\/v1\/source=[a-z]+\/(workspace|user)=[A-Za-z0-9_-]+\/connection=int_[a-f0-9]{26}\/$/.test(prefix))deny();
      let deleted=0;
      // The connector must be stopped before entering this operation. Delete bounded pages,
      // then relist the beginning so page tokens cannot skip keys after mutations.
      while(true){const page=await store.listPage(prefix);if(!page.keys.length)break;for(const key of page.keys){if(!key.startsWith(prefix))deny();await store.delete(key);deleted++;}}
      return deleted;
    },
  };
}
export function singleOrganizationDestination({organizationId,bucket,region,endpoint,accessKeyId,secretAccessKey,definitionId}: {
  organizationId:string;bucket:string;region:string;endpoint?:string;accessKeyId:string;secretAccessKey:string;definitionId?:string;
}):LandingDestination {
  const validate=(record:IntegrationRecord)=>{
    if(record.environment!=='selfhost'||record.tenantId!==organizationId||record.s3Bucket!==bucket||!record.s3Prefix?.startsWith('raw/v1/source=')||record.s3Prefix.split('/').some(p=>p==='.'||p==='..'))throw new Error('Invalid self-hosted landing destination');
  };
  return {validate,async prepare(record){validate(record);return {airbyteLandingMode:'operator-owned'};},async settings(record){validate(record);return {definitionId,configuration:{
    ...landingDestinationConfiguration(record,region),access_key_id:accessKeyId,secret_access_key:secretAccessKey,
    ...(endpoint?{s3_endpoint:endpoint}:{}),
  }};}};
}
