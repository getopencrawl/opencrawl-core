import {createHash} from 'node:crypto';
import {applicationDatabaseFixture} from './application-database.mjs';
import {createPostgresBoardState} from '../../dist/src/state/board.mjs';
import {createBoard} from '../../dist/src/board/board.mjs';
export const boardTenant=tenant=>createHash('sha256').update(tenant).digest('hex');
export async function boardStateFixture(t,options){
  const database=await applicationDatabaseFixture(t,options),repository=createPostgresBoardState(database);await repository.ready();
  const state={namespace:database.namespace,board:repository};
  const store={async readVersion(key){const value=await repository.exportLegacy(key.match(/([a-f0-9]{64})\.json$/)[1]);const data=value?Buffer.from(JSON.stringify(value)):null;return {data,version:data?createHash('sha256').update(data).digest('hex'):null};},async compareAndSet(key,version,data){if(version!==null)throw new Error('Fixture import only accepts fresh legacy state');await repository.importLegacy(key.match(/([a-f0-9]{64})\.json$/)[1],JSON.parse(data));return true;}};
  return {database,repository,state,store,make:options=>createBoard({state,...options})};
}
