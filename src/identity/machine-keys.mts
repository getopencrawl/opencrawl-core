import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {ApplicationDatabase} from '../state/postgres.mjs';
import type {Principal} from './types.mjs';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const denied = () => Object.assign(new Error('API key access denied'), {status:403});
type Key = {id:string; name:string; createdAt:Date};

/** The pool is bound to this installation's local identity schema. */
export function machineKeys(pool:ApplicationDatabase['identityPool'], organization:string) {
  const authenticated = new WeakMap<Principal,string>();
  const owner = (id:string) => 'workload_machine_' + digest(JSON.stringify([organization,id]));
  const list = async () => (await pool.query<Key>(
    'SELECT id,name,created_at AS "createdAt" FROM opencrawl_machine_keys WHERE organization=$1 ORDER BY created_at,id',
    [organization])).rows;
  return {
    list,
    async create(name:unknown) {
      if(typeof name!=='string' || !name.trim() || name.trim().length>64 || /[\x00-\x1f\x7f]/.test(name))
        throw Object.assign(new Error('Enter a name between 1 and 64 characters.'),{status:400,expose:true});
      const secret='oca1_'+randomBytes(32).toString('hex');
      const {rows}=await pool.query<Key>(`INSERT INTO opencrawl_machine_keys (organization,id,name,verifier)
        VALUES ($1,$2,$3,$4) ON CONFLICT (organization,name) DO NOTHING
        RETURNING id,name,created_at AS "createdAt"`,[organization,randomUUID(),name.trim(),digest(secret)]);
      if(!rows.length)throw Object.assign(new Error('An active key already has this name.'),{status:409,expose:true});
      return {key:rows[0]!,secret};
    },
    async revoke(id:unknown) {
      if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
        throw Object.assign(new Error('Invalid API key ID.'),{status:400,expose:true});
      await pool.query('DELETE FROM opencrawl_machine_keys WHERE organization=$1 AND id=$2',[organization,id]);
    },
    async sharedInstallations() {
      return (await list()).map(key=>({id:owner(key.id),tenantId:organization,userId:owner(key.id),name:key.name}));
    },
    async identify(token:string) {
      if(!/^oca1_[a-f0-9]{64}$/.test(token))return {status:401 as const};
      const key=(await pool.query<Pick<Key,'id'|'name'>>('SELECT id,name FROM opencrawl_machine_keys WHERE organization=$1 AND verifier=$2',[organization,digest(token)])).rows[0];
      if(!key)return {status:401 as const};
      const principal:Principal={tenantId:organization,userId:owner(key.id),name:key.name,owner:{kind:'shared',provider:'machine',name:key.name}};
      authenticated.set(principal,key.id);
      return {status:200 as const,user:{id:principal.userId,email:null},principal};
    },
    async authorize(principal:Principal) {
      const id=authenticated.get(principal);
      if(!id||principal.tenantId!==organization||principal.userId!==owner(id))throw denied();
      const {rowCount}=await pool.query('SELECT 1 FROM opencrawl_machine_keys WHERE organization=$1 AND id=$2',[organization,id]);
      if(!rowCount)throw denied();
      return principal;
    },
  };
}
