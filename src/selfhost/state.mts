import {requireScopedState} from '../state/scoped.mjs';
import type {ApplicationDatabase} from '../state/postgres.mjs';
import type {ApplicationState} from '../state/types.mjs';
import {applicationDatabase} from '../state/settings.mjs';
import {createPostgresBoardState} from '../state/board.mjs';

/** Scoped PostgreSQL runtime. A full-state installation cannot fall back to
 * stale object-store controls: retain its existing release for recovery. */
export async function selfhostState(env:NodeJS.ProcessEnv=process.env):Promise<{database:ApplicationDatabase;state:ApplicationState}>{
  const database=applicationDatabase(env);
  try{
    await database.ready();
    await requireScopedState(database);
    const board=createPostgresBoardState(database);await board.ready();
    return {database,state:{namespace:database.namespace,board}};
  }catch(error){await database.close();throw error;}
}
