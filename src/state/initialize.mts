/** Creates the application-state schema on an empty PostgreSQL database and
 * answers the readiness check. There is no import from an earlier release. */
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {applicationDatabase} from './settings.mjs';
import {prepareScopedState,requireScopedState} from './scoped.mjs';
import {createOnboardingRepository} from './onboarding.mjs';
import {createCredentialState} from './credentials.mjs';
import {sessionStorage} from '../sessions/storage.mjs';
import {createPostgresBoardState} from './board.mjs';
import {ensureIdentitySchema} from '../identity/better-auth.mjs';
import {createSingleOrganizationRegistry} from '../integrations/local-registry.mjs';
import type {ApplicationDatabase} from './postgres.mjs';
export type InitializeCommand='initialize'|'verify';
const commands:readonly string[]=['initialize','verify'];
export async function initializeApplicationState({database,bucket,prefix,organizationId,url,secret,command,store,allocatedLandingPrefix}:{
  allocatedLandingPrefix?:string;
  store?:ReturnType<typeof sessionStorage>['store'];database:ApplicationDatabase;bucket:string;prefix:string;organizationId:string;url:string;secret:string;command:InitializeCommand;
}){
  if(!commands.includes(command)||!/^org_[A-Za-z0-9]+$/.test(organizationId)||database.sourceIdentity?.organizationId!==organizationId||database.sourceIdentity.prefix!==prefix||database.sourceIdentity.bucket!==bucket)throw new Error('Exact application-state binding required');
  await prepareScopedState(database);
  const client=await database.pool.connect(),lock=database.namespace+':scoped-import';
  try{
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lock]);
    if((await client.query('SELECT 1 FROM opencrawl_application_installations WHERE namespace=$1',[database.namespace])).rows.length)throw new Error('This database holds an unsupported earlier installation; start from an empty database');
    const previous=(await client.query('SELECT source_identity,state FROM opencrawl_scoped_installations WHERE namespace=$1',[database.namespace])).rows[0];
    if(previous&&!isDeepStrictEqual(previous.source_identity,database.sourceIdentity))throw new Error('Application-state binding differs');
    if(previous?.state==='ready'){await requireScopedState(database);return {command,ready:true,created:false};}
    if(command==='verify')throw new Error('Application state has not been initialized');
    await client.query('INSERT INTO opencrawl_scoped_installations(namespace,source_identity,source_hash,state) VALUES($1,$2::jsonb,$3,\'importing\') ON CONFLICT DO NOTHING',[database.namespace,JSON.stringify(database.sourceIdentity),'fresh']);
    // Never mark a database ready that already holds data this run did not create.
    await ensureIdentitySchema({database,organizationId,url,secret});
    if(Number((await database.identityPool.query('SELECT count(*) FROM "user"')).rows[0].count))throw new Error('Database already contains identity data; start from an empty database');
    const registry=createSingleOrganizationRegistry({database,organizationId});await registry.ready();
    if((await registry.listTenant(organizationId)).length)throw new Error('Database already contains integration data; start from an empty database');
    const board=createPostgresBoardState(database);await board.ready();
    if((await database.pool.query('SELECT 1 FROM opencrawl_board_heads WHERE namespace=$1 LIMIT 1',[database.namespace])).rows.length)throw new Error('Database already contains board data; start from an empty database');
    if(store){
      await createOnboardingRepository(database,store,prefix).migrate();
      if(allocatedLandingPrefix===prefix){
        // Only a prefix allocated by the installer can bootstrap without a legacy writer drain.
        // If it has since accumulated credentials, keep the object bridge for explicit migration.
        const populated=Error('Allocated credential source already populated');
        try {
          await createCredentialState(database,store,prefix).migrate('activate',async receipt=>{
            if(receipt.capture.records || receipt.capture.generations || receipt.agent.records || receipt.agent.generations)throw populated;
          });
        } catch(error){if(error!==populated)throw error;}
      }
    }
    await client.query("UPDATE opencrawl_scoped_installations SET state='ready',verified_at=now() WHERE namespace=$1",[database.namespace]);
    await requireScopedState(database);return {command,ready:true,created:true};
  }finally{try{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);}finally{client.release();}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [command,...rest]=process.argv.slice(2);
  if(!commands.includes(command||'')||rest.length)throw new Error('Usage: state/initialize initialize|verify');
  const database=applicationDatabase(),{store,prefix}=sessionStorage();
  try{await store.checkAccess();console.log(JSON.stringify(await initializeApplicationState({database,store,bucket:store.bucket||'',prefix,allocatedLandingPrefix:process.env.OPENCRAWL_ALLOCATED_LANDING_PREFIX,organizationId:process.env.OPENCRAWL_ORGANIZATION_ID||'',url:process.env.OPENCRAWL_URL||'',secret:process.env.OPENCRAWL_AUTH_SECRET||'',command:command as InitializeCommand})));}
  finally{await database.close();}
}
