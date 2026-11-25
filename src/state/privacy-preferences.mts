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
  return {
    async read(subject) {
      const result=await db.query<StoredPrivacyPreference>(`SELECT enabled,rules,revision FROM ${table} WHERE namespace=$1 AND subject=$2`,scope(subject));
      return result.rows[0]??null;
    },
    async replace(subject,expected,next) {
      const values=[...scope(subject),next.enabled,next.rules,next.revision,expected];
      const result=expected==='0'
        ? await db.query(`INSERT INTO ${table}(namespace,subject,enabled,rules,revision) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(namespace,subject) DO UPDATE SET enabled=EXCLUDED.enabled,rules=EXCLUDED.rules,revision=EXCLUDED.revision
            WHERE ${table}.revision=$6`,values)
        : await db.query(`UPDATE ${table} SET enabled=$3,rules=$4,revision=$5 WHERE namespace=$1 AND subject=$2 AND revision=$6`,values);
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
