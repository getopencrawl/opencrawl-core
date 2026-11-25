import {randomBytes,randomUUID} from 'node:crypto';
import type {ApplicationDatabase} from './postgres.mjs';
import type {Principal,StoreVersion} from '../sessions/types.mjs';
import {sessionScope} from '../sessions/event-identity.mjs';
import {checkedCredentialRecord,type CredentialRepository} from '../sessions/credential-service.mjs';
import {fail} from '../errors.mjs';

export const credentialFamilies=['capture','agent'] as const;
export type CredentialFamily=typeof credentialFamilies[number];
const records='opencrawl_credential_records',markers='opencrawl_credential_generations';

export function credentialOwner(principal:Principal,organizationId:string|null) {
  const scope=sessionScope(principal);
  if(organizationId && principal.tenantId!==organizationId)fail(403,'Credential owner outside configured organization');
  return scope;
}

export function postgresCredentialRepository(database:ApplicationDatabase,family:CredentialFamily,ready?:()=>Promise<void>):CredentialRepository {
  if(!credentialFamilies.includes(family))throw Error('Unknown credential family');
  const source=database.sourceIdentity,ns=database.namespace;
  if(!source)throw Error('Credential storage binding required');
  const owner=(principal:Principal)=>credentialOwner(principal,source.organizationId);
  return {
    async create(record) {
      checkedCredentialRecord(record,record.id);
      const scope=owner(record.principal);
      await ready?.();
      await database.pool.query(`INSERT INTO ${records}(namespace,family,id,owner,expires_at,record)
        VALUES($1,$2,$3,$4,$6::timestamptz,$5::jsonb || jsonb_build_object('generation',
          coalesce((SELECT generation FROM ${markers} WHERE namespace=$1 AND family=$2 AND owner=$4),'')))`,
        [ns,family,record.id,scope,record,record.expiresAt]);
    },
    async lookup(id,clock) {
      await ready?.();
      const {rows:[row]}=await database.pool.query(`SELECT c.record,c.owner,c.expires_at FROM ${records} c
        LEFT JOIN ${markers} g ON g.namespace=c.namespace AND g.family=c.family AND g.owner=c.owner
        WHERE c.namespace=$1 AND c.family=$2 AND c.id=$3 AND NOT c.revoked AND c.expires_at>$4::timestamptz
        AND c.generation=coalesce(g.generation,'')`,[ns,family,id,new Date(clock()).toISOString()]);
      if(!row)return null;
      const record=checkedCredentialRecord(row.record,id);
      if(record.revoked || owner(record.principal)!==row.owner || Date.parse(record.expiresAt)!==row.expires_at.getTime())
        throw Error('Credential binding unavailable');
      return {principal:record.principal,expiresAt:record.expiresAt};
    },
    async removalVersion(principal) {
      const scope=owner(principal);
      await ready?.();
      const {rows:[marker]}=await database.pool.query(`SELECT version FROM ${markers} WHERE namespace=$1 AND family=$2 AND owner=$3`,[ns,family,scope]);
      return marker?.version as StoreVersion|undefined ?? null;
    },
    async rotate(principal,version) {
      const scope=owner(principal);
      await ready?.();
      const values=[ns,family,scope,randomBytes(32).toString('hex'),JSON.stringify('pg:'+randomUUID())];
      if(version!=null) {
        await database.pool.query(`UPDATE ${markers} SET generation=$4,version=$5::jsonb
          WHERE namespace=$1 AND family=$2 AND owner=$3 AND version=$6::jsonb`,[...values,JSON.stringify(version)]);
        return;
      }
      const conflict=version===null?'DO NOTHING':'DO UPDATE SET generation=excluded.generation,version=excluded.version';
      await database.pool.query(`INSERT INTO ${markers}(namespace,family,owner,generation,version)
        VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(namespace,family,owner) `+conflict,values);
    },
    async revoke(principal,id) {
      const scope=owner(principal);
      await ready?.();
      await database.transaction(async db=>{
        const {rows:[current]}=await db.query(`SELECT owner FROM ${records} WHERE namespace=$1 AND family=$2 AND id=$3 FOR UPDATE`,[ns,family,id]);
        if(!current)return;
        if(current.owner!==scope)fail(403,'Credential owner mismatch');
        await db.query(`UPDATE ${records} SET record=jsonb_set(record,'{revoked}','true')
          WHERE namespace=$1 AND family=$2 AND id=$3`,[ns,family,id]);
      });
    },
  };
}
