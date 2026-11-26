import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {smallJson} from '../application/http.mjs';
import {errorInfo} from '../errors.mjs';
import type {ApplicationDatabase} from '../state/postgres.mjs';
import type {Principal} from './types.mjs';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const denied = () => Object.assign(new Error('API key access denied'), {status:403});
type Key = {id:string; name:string; createdAt:Date};

export function machineKeyName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name))
    throw Object.assign(new Error('Enter a name between 1 and 64 characters.'), {status: 400, expose: true});
  return name.trim();
}

export function machineOwnerId(organization: string, keyId: string): string {
  return 'workload_machine_' + digest(JSON.stringify([organization, keyId]));
}

export function machinePrincipal(organization: string, key: Pick<Key, 'id' | 'name'>): Principal {
  return {tenantId: organization, userId: machineOwnerId(organization, key.id), name: key.name,
    owner: {kind: 'shared', provider: 'machine', name: key.name}};
}

export function machineInstallation(organization: string, key: Pick<Key, 'id' | 'name'>) {
  const id = machineOwnerId(organization, key.id);
  return {id, tenantId: organization, userId: id, name: key.name};
}

interface MachineKeyManagement {
  list(): Promise<Key[]>;
  create(name: unknown): Promise<{key: Key; secret: string}>;
  revoke(id: unknown): Promise<void>;
}

/** Call with the current browser membership and an adapter bound to that workspace. */
export async function manageMachineKeys(req: IncomingMessage, revoke: boolean, admin: boolean, keys: MachineKeyManagement) {
  if (!admin) return {status: 403, body: {error: 'Workspace administrator access required.'}};
  try {
    if (req.method === 'GET' && !revoke) return {status: 200, body: {keys: await keys.list()}};
    if (req.method !== 'POST') return {status: 405, body: {error: 'Method not allowed'}};
    const input = await smallJson(req);
    if (revoke) {
      await keys.revoke(input.id);
      return {status: 200, body: {ok: true}};
    }
    return {status: 201, body: await keys.create(input.name)};
  } catch (error) {
    const info = errorInfo(error);
    return info.expose ? {status: info.status ?? 400, body: {error: info.message}}
      : {status: 503, body: {error: 'API keys are temporarily unavailable.'}};
  }
}

/** The pool is bound to this installation's local identity schema. */
export function machineKeys(pool:ApplicationDatabase['identityPool'], organization:string) {
  const authenticated = new WeakMap<Principal,string>();
  const list = async () => (await pool.query<Key>(
    'SELECT id,name,created_at AS "createdAt" FROM opencrawl_machine_keys WHERE organization=$1 ORDER BY created_at,id',
    [organization])).rows;
  return {
    list,
    async create(name:unknown) {
      const label = machineKeyName(name);
      const secret='oca1_'+randomBytes(32).toString('hex');
      const {rows}=await pool.query<Key>(`INSERT INTO opencrawl_machine_keys (organization,id,name,verifier)
        VALUES ($1,$2,$3,$4) ON CONFLICT (organization,name) DO NOTHING
        RETURNING id,name,created_at AS "createdAt"`,[organization,randomUUID(),label,digest(secret)]);
      if(!rows.length)throw Object.assign(new Error('An active key already has this name.'),{status:409,expose:true});
      return {key:rows[0]!,secret};
    },
    async revoke(id:unknown) {
      if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
        throw Object.assign(new Error('Invalid API key ID.'),{status:400,expose:true});
      await pool.query('DELETE FROM opencrawl_machine_keys WHERE organization=$1 AND id=$2',[organization,id]);
    },
    async sharedInstallations() {
      return (await list()).map(key => machineInstallation(organization, key));
    },
    async identify(token:string) {
      if(!/^oca1_[a-f0-9]{64}$/.test(token))return {status:401 as const};
      const key=(await pool.query<Pick<Key,'id'|'name'>>('SELECT id,name FROM opencrawl_machine_keys WHERE organization=$1 AND verifier=$2',[organization,digest(token)])).rows[0];
      if(!key)return {status:401 as const};
      const principal = machinePrincipal(organization, key);
      authenticated.set(principal,key.id);
      return {status:200 as const,user:{id:principal.userId,email:null},principal};
    },
    async authorize(principal:Principal) {
      const id=authenticated.get(principal);
      if(!id||principal.tenantId!==organization||principal.userId!==machineOwnerId(organization,id))throw denied();
      const {rowCount}=await pool.query('SELECT 1 FROM opencrawl_machine_keys WHERE organization=$1 AND id=$2',[organization,id]);
      if(!rowCount)throw denied();
      return principal;
    },
  };
}
