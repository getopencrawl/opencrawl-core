import type {ApplicationDatabase} from './postgres.mjs';
import {controlIdentities,postgresControlRows,readResourceControlSeal} from './resource-control-rows.mjs';

/** Opens only already verified SQL state. The resource queries also check its
 * installation binding in their own snapshot; a missing seal is never public. */
export function createPostgresResourceControls(database:ApplicationDatabase) {
  const source=database.sourceIdentity;
  if(!source)throw Error('Resource control source binding required');
  const controls=postgresControlRows(database,controlIdentities(source.organizationId));
  async function ready(){
    if(!await readResourceControlSeal(database.pool,database.namespace,source))throw Error('Verified resource control authority is unavailable');
  }
  return {controls,ready};
}
