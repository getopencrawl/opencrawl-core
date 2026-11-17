/** Offline import of exactly three domains: Better Auth, registry, and board.
 * Other state and raw content retain their production storage contracts. */
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {applicationDatabase} from './settings.mjs';
import {prepareScopedState,requireScopedState} from './scoped.mjs';
import {sessionStorage} from '../sessions/storage.mjs';
import {migrateIdentitySqlite} from './identity-migration.mjs';
import {migrateRegistrySqlite} from './registry-migration.mjs';
import {createPostgresBoardState,validateLegacyBoard} from './board.mjs';
import {ensureIdentitySchema} from '../identity/better-auth.mjs';
import {createSingleOrganizationRegistry} from '../integrations/local-registry.mjs';
import {canonical,type ImportMode} from './sqlite-import.mjs';
import type {ApplicationDatabase} from './postgres.mjs';
import type {ObjectStore} from '../sessions/types.mjs';
import type {BoardState} from '../board/types.mjs';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
async function fileHash(path:string){
  try{if(!(await stat(path)).isFile())throw new Error('Legacy SQLite source must be a regular file');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest('hex');
}
export async function migrateScopedState({database,store,prefix,organizationId,url,secret,identityPath,registryPath,mode,writersStopped=false,expectExisting=false}:{
  database:ApplicationDatabase;store:ObjectStore;prefix:string;organizationId:string;url:string;secret:string;
  identityPath:string;registryPath:string;mode:ImportMode;writersStopped?:boolean;expectExisting?:boolean;
}){
  if(!['check','migrate','verify'].includes(mode)||!/^org_[A-Za-z0-9]+$/.test(organizationId)||database.sourceIdentity?.organizationId!==organizationId||database.sourceIdentity.prefix!==prefix||database.sourceIdentity.bucket!==store.bucket)throw new Error('Exact scoped-state source binding required');
  await prepareScopedState(database);
  const client=await database.pool.connect(),lock=database.namespace+':scoped-import';
  try{
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lock]);
    if((await client.query('SELECT 1 FROM opencrawl_application_installations WHERE namespace=$1',[database.namespace])).rows.length)throw new Error('Whole-application migration cannot be reversed by the scoped importer; retain the existing release and verified recovery point');
    const previous=(await client.query('SELECT source_identity,source_hash,state FROM opencrawl_scoped_installations WHERE namespace=$1',[database.namespace])).rows[0];
    if(previous&&!isDeepStrictEqual(previous.source_identity,database.sourceIdentity))throw new Error('Scoped source binding differs');
    // A completed domain import never replays stale legacy files over live rows.
    if(previous?.state==='ready'){await requireScopedState(database);return {scope:'auth-registry-board',mode,ready:true,reused:true};}
    if(mode==='verify')throw new Error('Scoped-state import has not completed');
    const tenant=hash(organizationId),boardKey=prefix+'/board/tenants/'+tenant+'.json';
    async function inventory(){
      const identity=await fileHash(identityPath),identityWal=await fileHash(identityPath+'-wal'),registry=await fileHash(registryPath),registryWal=await fileHash(registryPath+'-wal');
      if(!identity&&identityWal||!registry&&registryWal)throw new Error('Legacy SQLite WAL has no database; restore the complete backup');
      const board=await store.readVersion(boardKey,{maxBytes:128*1024*1024});
      return {identity,identityWal,registry,registryWal,board:board.data?hash(board.data):null};
    }
    const inputs=await inventory(),sourceHash=hash(canonical(inputs)),legacy=Object.values(inputs).some(Boolean);
    if(previous&&previous.source_hash!==sourceHash)throw new Error('Source changed during scoped import; restore the verified recovery point');
    if(expectExisting&&!inputs.identity)throw new Error('Existing installation has no legacy identity database; preserve and review its recovery point');
    if(legacy&&!writersStopped)throw new Error('Stop application, workers and external source writers before importing existing state');
    const identity={database,path:identityPath,organizationId,url,secret};
    if(inputs.identity)await migrateIdentitySqlite({...identity,mode:'check'});
    if(inputs.registry)await migrateRegistrySqlite({database,path:registryPath,organizationId,mode:'check'});
    let board:BoardState|null=null;
    if(inputs.board){const raw=await store.readVersion(boardKey,{maxBytes:128*1024*1024});if(!raw.data||hash(raw.data)!==inputs.board)throw new Error('Board source changed');board=JSON.parse(raw.data.toString('utf8')) as BoardState;validateLegacyBoard(board);}
    if(mode==='check')return {scope:'auth-registry-board',mode,ready:false,legacy};
    await client.query('INSERT INTO opencrawl_scoped_installations(namespace,source_identity,source_hash,state) VALUES($1,$2::jsonb,$3,\'importing\') ON CONFLICT DO NOTHING',[database.namespace,JSON.stringify(database.sourceIdentity),sourceHash]);
    if(inputs.identity)await migrateIdentitySqlite({...identity,mode:'migrate'});else{
      await ensureIdentitySchema(identity);
      if(Number((await database.identityPool.query('SELECT count(*) FROM "user"')).rows[0].count))throw new Error('Target identity has data absent from the source');
    }
    const registry=createSingleOrganizationRegistry({database,organizationId});await registry.ready();
    if(inputs.registry)await migrateRegistrySqlite({database,path:registryPath,organizationId,mode:'migrate'});
    else if((await registry.listTenant(organizationId)).length)throw new Error('Target registry has data absent from the source');
    const repository=createPostgresBoardState(database);await repository.ready();
    if((await database.pool.query('SELECT 1 FROM opencrawl_board_heads WHERE namespace=$1 AND tenant_hash<>$2',[database.namespace,tenant])).rows.length)throw new Error('Target board contains foreign scope');
    if(board)await repository.importLegacy(tenant,board);else if(await repository.exportLegacy(tenant))throw new Error('Target board has data absent from the source');
    if(sourceHash!==hash(canonical(await inventory())))throw new Error('Source changed during import; keep writers stopped');
    await client.query("UPDATE opencrawl_scoped_installations SET state='ready',verified_at=now() WHERE namespace=$1",[database.namespace]);
    await requireScopedState(database);return {scope:'auth-registry-board',mode,ready:true,reused:false};
  }finally{try{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);}finally{client.release();}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [mode,...flags]=process.argv.slice(2);
  if(!['check','migrate','verify'].includes(mode||'')||flags.some(flag=>!['--writers-stopped','--expect-existing'].includes(flag)))throw new Error('Usage: state/migrate check|migrate|verify [--writers-stopped] [--expect-existing]');
  const database=applicationDatabase(),{store,prefix}=sessionStorage();
  try{await store.checkAccess();console.log(JSON.stringify(await migrateScopedState({database,store,prefix,organizationId:process.env.OPENCRAWL_ORGANIZATION_ID||'',url:process.env.OPENCRAWL_URL||'',secret:process.env.OPENCRAWL_AUTH_SECRET||'',identityPath:process.env.OPENCRAWL_IDENTITY_PATH||'/data/identity.sqlite',registryPath:process.env.OPENCRAWL_REGISTRY_PATH||'/data/integrations.sqlite',mode:mode as ImportMode,writersStopped:flags.includes('--writers-stopped'),expectExisting:flags.includes('--expect-existing')})));}
  finally{await database.close();}
}
