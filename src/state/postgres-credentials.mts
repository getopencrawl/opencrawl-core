import {credentialService} from '../sessions/credential-service.mjs';
import {postgresCredentialRepository,type CredentialFamily} from './credential-records.mjs';
import type {ApplicationDatabase} from './postgres.mjs';

export type {CredentialFamily} from './credential-records.mjs';

/** Only a previously activated, source-bound installation may serve credentials. */
export function createPostgresCredentialState(database:ApplicationDatabase) {
  const {namespace,sourceIdentity}=database;
  if(!sourceIdentity)throw Error('Credential storage binding required');
  let checked:Promise<void>|undefined;
  function ready() {
    checked??=database.pool.query(`SELECT 1 FROM opencrawl_credential_authority WHERE namespace=$1 AND source=$2::jsonb
      AND receipt IS NOT NULL AND activated_at IS NOT NULL`,[namespace,sourceIdentity]).then(({rowCount})=>{
      if(rowCount!==1)throw Error('PostgreSQL credential authority is not active for this installation');
    }).catch(error=>{checked=undefined;throw error;});
    return checked;
  }
  return {ready,credentials(family:CredentialFamily,{now=Date.now}:{now?:()=>number}={}){
    return credentialService(postgresCredentialRepository(database,family,ready),now);
  }};
}
