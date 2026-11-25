import type {ApplicationDatabase,ApplicationTransaction} from './postgres.mjs';
import type {PrivacyPreferenceRepository,StoredPrivacyPreference} from '../sessions/privacy.mjs';

const table='opencrawl_privacy_preferences';
const protectedSubject=/^tenants\/[0-9a-f]{64}\/users\/[0-9a-f]{64}$/;
type Reader=Pick<ApplicationTransaction,'query'>;

export async function preparePrivacyPreferences(database:ApplicationDatabase) {
  await database.transaction(async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:privacy-preferences:schema',0))");
    await db.query(`CREATE TABLE IF NOT EXISTS ${table} (
      namespace text NOT NULL, subject text NOT NULL CHECK (subject ~ '^tenants/[0-9a-f]{64}/users/[0-9a-f]{64}$'),
      enabled boolean NOT NULL, rules text NOT NULL, revision text NOT NULL,
      PRIMARY KEY(namespace,subject))`);
    await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS json_escaped boolean NOT NULL DEFAULT false`);
  });
}

/** The source subject is the existing trusted session scope, including both owner hashes.
 * No raw owner IDs or rule text are exposed by the migration inventory. */
export function postgresPrivacyPreferenceRepository(db:Reader,namespace:string):PrivacyPreferenceRepository {
  if (!namespace) throw Error('Privacy preferences require an application namespace');
  function scope(subject:string) {
    if(!protectedSubject.test(subject))throw Error('Invalid privacy preference subject');
    return [namespace,subject];
  }
  // PostgreSQL text excludes NUL and isolated UTF-16 surrogates. Preserve all
  // strings accepted by the JSON API while keeping ordinary rows readable.
  const textSafe=(value:string)=>value.isWellFormed()&&!value.includes('\0');
  return {
    async read(subject) {
      const result=await db.query<StoredPrivacyPreference & {json_escaped:boolean}>(`SELECT enabled,rules,revision,json_escaped FROM ${table} WHERE namespace=$1 AND subject=$2`,scope(subject));
      const row=result.rows[0];
      if(!row)return null;
      const {enabled,rules,revision,json_escaped}=row;
      return json_escaped?{enabled,rules:JSON.parse(rules),revision:JSON.parse(revision)}:{enabled,rules,revision};
    },
    async replace(subject,expected,next) {
      const escape=!textSafe(next.rules)||!textSafe(next.revision);
      const values=[...scope(subject),next.enabled,escape?JSON.stringify(next.rules):next.rules,
        escape?JSON.stringify(next.revision):next.revision,escape,textSafe(expected)?expected:null,JSON.stringify(expected)];
      const matches=`${table}.revision=CASE WHEN ${table}.json_escaped THEN $8::text ELSE $7::text END`;
      const result=expected==='0'
        ? await db.query(`INSERT INTO ${table}(namespace,subject,enabled,rules,revision,json_escaped) VALUES($1,$2,$3,$4,$5,$6)
            ON CONFLICT(namespace,subject) DO UPDATE SET enabled=EXCLUDED.enabled,rules=EXCLUDED.rules,revision=EXCLUDED.revision,json_escaped=EXCLUDED.json_escaped
            WHERE ${matches}`,values)
        : await db.query(`UPDATE ${table} SET enabled=$3,rules=$4,revision=$5,json_escaped=$6 WHERE namespace=$1 AND subject=$2 AND ${matches}`,values);
      return result.rowCount===1;
    },
  };
}

/** Called by a fenced domain cutover. Keyset pagination uses the primary key. */
export async function listPrivacyPreferenceSubjects(db:Reader,namespace:string,after='') {
  if(!namespace||after&&!protectedSubject.test(after))throw Error('Invalid privacy preference inventory');
  const {rows}=await db.query<{subject:string}>(`SELECT subject FROM ${table}
    WHERE namespace=$1 AND subject>$2 ORDER BY subject LIMIT 256`,[namespace,after]);
  return rows.map(row=>row.subject);
}

export async function countPrivacyPreferences(db:Reader,namespace:string) {
  if(!namespace)throw Error('Privacy preferences require an application namespace');
  const result=await db.query<{total:string}>(`SELECT count(*) AS total FROM ${table} WHERE namespace=$1`,[namespace]);
  return Number(result.rows[0]!.total);
}
