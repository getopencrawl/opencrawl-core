import {randomUUID} from 'node:crypto';
import type {ApplicationDatabase} from '../state/postgres.mjs';
import type {ConditionalStore, Principal, StoreVersion} from '../sessions/types.mjs';
import type {IdentityDirectory} from './types.mjs';
import {errorInfo} from '../errors.mjs';
import {authorizeTeamChange, applyTeamChange, verifyTeamChange, teamChange, rejectChange, type ChangeOutcome, type TeamChange} from './team-change.mjs';
import {roleWriteGuard,releaseRoleWrite,ownsRoleWrite} from './role-write.mjs';

export interface TeamOperationRef {organizationId:string; operationId:string}
export interface TeamChangeResult {review:boolean; outcome:ChangeOutcome}
export interface RemovalCredentials {
  removalVersion(owner:Principal):Promise<StoreVersion|null>;
  revokeVersion(owner:Principal,version:StoreVersion|null):Promise<void>;
}
export interface TeamChangeOptions {
  database:ApplicationDatabase; directory:IdentityDirectory; store:ConditionalStore; prefix:string;
  credentials:Record<string,RemovalCredentials>; organizationId?:string;
  checkLastAdmin?:(organizationId:string,targetId:string)=>Promise<void>;
}
type Versions=Record<string,StoreVersion|null>;
interface Row {
  actor:string;target:string;role:TeamChange['role'];phase:'queued'|'guarded'|'dispatching'|'applied'|'release'|'done';
  actor_membership:string;membership:string;versions:Versions|null;outcome:ChangeOutcome|null;
}
const table='opencrawl_team_operations';
const where='namespace=$1 AND organization=$2 AND operation=$3';
const held:TeamChangeResult={review:true,outcome:{ok:false,status:503,message:'The team change is awaiting verification. Contact your workspace operator.'}};
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const tenant=/^org_[A-Za-z0-9]+$/;
const user=/^user_[A-Za-z0-9]+$/;

export async function prepareTeamOperations(database:ApplicationDatabase) {
  await database.ready();
  await database.transaction(async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:team-operations:schema',0))");
    await db.query(`CREATE TABLE IF NOT EXISTS ${table} (
      namespace text NOT NULL,organization text NOT NULL,operation uuid NOT NULL,actor text NOT NULL,target text NOT NULL,
      role text NOT NULL CHECK(role IN ('admin','member','remove')),
      phase text NOT NULL CHECK(phase IN ('queued','guarded','dispatching','applied','release','done')),
      actor_membership text NOT NULL,membership text NOT NULL,versions jsonb,outcome jsonb,
      PRIMARY KEY(namespace,organization,operation))`);
  });
}

function binding(database:ApplicationDatabase,ref:TeamOperationRef) {
  if (!tenant.test(ref?.organizationId) || !uuid.test(ref?.operationId)) throw Error('Invalid team operation reference');
  return [database.namespace,ref.organizationId,ref.operationId];
}
function lockKey(key:string[]) {return JSON.stringify(['team-operation',...key]);}

/** The first activity takes this same lock before reading the committed admission.
 * A start lost before commit consequently has neither authority nor a guard. */
export async function admitTeamChange<T>(database:ApplicationDatabase,change:TeamChange,start:(ref:TeamOperationRef)=>Promise<T>) {
  teamChange(change.organizationId,change.actorId,change.userId,change.role);
  if (!user.test(change.actorId)) rejectChange(403,'An authenticated teammate is required.');
  if (!change.actorMembershipId || !change.targetMembershipId) rejectChange(409,'The workspace membership could not be confirmed.');
  const ref={organizationId:change.organizationId,operationId:randomUUID()}, key=binding(database,ref);
  return database.transaction(async db=>{
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lockKey(key)]);
    await db.query(`INSERT INTO ${table}(namespace,organization,operation,actor,target,role,actor_membership,membership,phase) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued')`,[...key,change.actorId,change.userId,change.role,change.actorMembershipId,change.targetMembershipId]);
    return start(ref);
  });
}

export function teamChangeActivities({database,directory,store,prefix,credentials,organizationId,checkLastAdmin}:TeamChangeOptions) {
  const getGuard=roleWriteGuard(store,prefix);
  return {
    async advanceTeamChange(ref:TeamOperationRef):Promise<TeamChangeResult> {
      const key=binding(database,ref);
      if (organizationId && organizationId!==ref.organizationId) throw Error('Team operation scope mismatch');
      const db=await database.pool.connect();
      try {
        // A session lock serializes late activity completions. Each checkpoint below
        // commits independently, before a potentially unfenceable provider call.
        await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lockKey(key)]);
        const {rows:[row]}=await db.query<Row>(`SELECT actor,target,role,phase,actor_membership,membership,versions,outcome FROM ${table} WHERE ${where}`,key);
        if (!row) return {review:false,outcome:{ok:false,status:409,message:'The team operation was not admitted.'}};
        const change={...teamChange(ref.organizationId,row.actor,row.target,row.role),actorMembershipId:row.actor_membership,targetMembershipId:row.membership};
        const principal={tenantId:ref.organizationId,userId:row.target};
        const done=async(outcome:ChangeOutcome,hasGuard:boolean)=>{
          const next=hasGuard?'release':'done';
          await db.query(`UPDATE ${table} SET phase=$4,outcome=$5 WHERE ${where}`,[...key,next,JSON.stringify(outcome)]);
          row.phase=next;row.outcome=outcome;
        };
        if (row.phase==='queued') {
          try {await getGuard(change.organizationId,change.actorId,change.userId,change.role,ref.operationId);}
          catch (error) {
            const {status,message,expose}=errorInfo(error);
            if (status!==409 || !expose) throw error;
            await done({ok:false,status,message},false);
          }
          if (row.phase==='queued') {
            await db.query(`UPDATE ${table} SET phase='guarded' WHERE ${where}`,key);
            row.phase='guarded';
          }
        }
        if ((row.phase==='guarded' || row.phase==='applied') && !await ownsRoleWrite(store,prefix,change.organizationId,ref.operationId)) return held;
        if (row.phase==='dispatching') return held;
        if (row.phase==='guarded') {
          let authorized:Awaited<ReturnType<typeof authorizeTeamChange>>|undefined;
          try {
            if (change.role!=='admin') await checkLastAdmin?.(change.organizationId,change.userId);
            const current=await authorizeTeamChange(directory,change);
            if (current.actorMembershipId!==change.actorMembershipId || current.targetMembershipId!==change.targetMembershipId)
              rejectChange(409,'Workspace membership changed after this team change was requested.');
            authorized=current;
          }
          catch (error) {
            const {status,message,expose}=errorInfo(error);
            if (!expose || !status || status>=500) throw error;
            await done({ok:false,status,message},true);
          }
          if (authorized && !authorized.needsWrite) await done({ok:true},true);
          if (authorized?.needsWrite) {
            let versions:Versions|null=null;
            if (change.role==='remove') {
              if (!Object.keys(credentials).length) throw Error('Removal credential stores missing');
              versions={};
              for (const [name,group] of Object.entries(credentials)) versions[name]=await group.removalVersion(principal);
            }
            await db.query(`UPDATE ${table} SET phase='dispatching',versions=$4 WHERE ${where}`,[...key,versions]);
            row.versions=versions;
            // From this point a timeout, process death, or lost response requires
            // provider evidence. An empty directory lookup cannot re-arm the write.
            try {await applyTeamChange(directory,change,change.targetMembershipId);}
            catch {return held;}
            await db.query(`UPDATE ${table} SET phase='applied' WHERE ${where}`,key);
            row.phase='applied';
          }
        }
        if (row.phase==='applied') {
          if (change.role==='remove') {
            // Always invalidate the generation that existed at dispatch, including
            // when WorkOS already shows a replacement membership. A repeated CAS
            // cannot rotate a newer generation issued after successful revocation.
            const versions=row.versions;
            if (!versions || !Object.keys(versions).length || Object.keys(credentials).sort().join(',')!==Object.keys(versions).sort().join(','))
              return held;
            for (const [name,version] of Object.entries(versions)) await credentials[name]!.revokeVersion(principal,version);
          }
          try {await verifyTeamChange(directory,change);}
          catch (error) {
            if (errorInfo(error).expose) return held;
            throw error;
          }
          await done({ok:true},true);
        }
        if (row.phase==='release') {
          await releaseRoleWrite(store,prefix,change.organizationId,ref.operationId,true);
          await db.query(`UPDATE ${table} SET phase='done' WHERE ${where}`,key);
        }
        if (!row.outcome) throw Error('Team operation has no recorded outcome');
        return {review:false,outcome:row.outcome};
      } catch {
        // Temporal history is operational metadata. Keep provider payloads and SQL details out of it.
        throw Error('Team operation temporarily unavailable');
      } finally {db.release(true);}
    },
    async forgetCompletedTeamChange(ref:TeamOperationRef) {
      if (organizationId && organizationId!==ref.organizationId) throw Error('Team operation scope mismatch');
      await database.pool.query(`DELETE FROM ${table} WHERE ${where} AND phase='done'`,binding(database,ref));
    },
  };
}
