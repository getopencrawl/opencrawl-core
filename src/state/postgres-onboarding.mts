import type {OnboardingRepository} from '../onboarding-receipts.mjs';
import {onboardingOwnerCheck,selectedReceipts,checkMilestone,writeOnboardingRow} from './onboarding-rows.mjs';
import type {ApplicationDatabase} from './postgres.mjs';

/** Steady-state receiver for a source-bound installation with completed onboarding import. */
export function createPostgresOnboardingRepository(database:ApplicationDatabase) {
  const {namespace,sourceIdentity}=database;
  if(!sourceIdentity)throw Error('Onboarding storage binding required');
  const source=JSON.stringify(sourceIdentity),authorize=onboardingOwnerCheck(sourceIdentity.organizationId);
  async function ready() {
    const {rowCount}=await database.pool.query(`SELECT 1 FROM opencrawl_onboarding_authority
      WHERE namespace=$1 AND source=$2::jsonb AND phase='postgres'`,[namespace,source]);
    if(rowCount!==1)throw Error('PostgreSQL onboarding authority is not active for this installation');
  }
  const repository:OnboardingRepository={
    async read(owner,kinds) {
      authorize(owner);
      const {rows:[row]}=await database.pool.query(`SELECT o.receipts FROM opencrawl_onboarding_authority a
        LEFT JOIN opencrawl_onboarding_owners o ON o.namespace=a.namespace AND o.owner=$2
        WHERE a.namespace=$1 AND a.source=$3::jsonb AND a.phase='postgres'`,[namespace,owner,source]);
      if(!row)throw Error('PostgreSQL onboarding authority is not active for this installation');
      return selectedReceipts(row.receipts,kinds);
    },
    async write(owner,kind,value) {
      authorize(owner);checkMilestone(kind,value);
      return writeOnboardingRow(database.pool,namespace,source,'postgres',owner,kind,value);
    },
  };
  return {repository,ready};
}
