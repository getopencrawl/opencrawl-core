import {createPostgresBoardState} from './board.mjs';
import {createPostgresIndexingReceipts} from './indexing-receipts.mjs';
import {createAccountState} from './account-state.mjs';
import {createConnectorSecrets} from './connector-secrets.mjs';
import {createPostgresSlackCapture} from './slack-capture.mjs';
import {createReplicasState} from './replicas.mjs';
import {createValueReports} from './value-reports.mjs';
import {createPostgresDeletionRequests,ensureDeletionRequestSchema} from './deletion-requests.mjs';
import type {ApplicationDatabase} from './postgres.mjs';
import type {ApplicationState} from './types.mjs';
import {createPostgresControls} from './resource-controls.mjs';
import {createPostgresWriteBarrier,ensureWriteBarrierSchema} from './write-barriers.mjs';

/** Schema preparation is deliberately separate from migration admission. The
 * runtime must requireApplicationStateReady before constructing request handlers. */
export async function createApplicationState({database,prepareSchema=true}:{database:ApplicationDatabase;prepareSchema?:boolean}):Promise<ApplicationState>{
  const board=createPostgresBoardState(database),controls=createPostgresControls(database),indexingReceipts=createPostgresIndexingReceipts(database),accounts=createAccountState(database),connectorSecrets=createConnectorSecrets(database),slackCapture=createPostgresSlackCapture(database),replicas=createReplicasState(database),valueReports=createValueReports(database);
  if(prepareSchema)await Promise.all([board.ready(),valueReports.ready(),replicas.ready(),slackCapture.ready(),connectorSecrets.ready(),accounts.ready(),controls.ready(),indexingReceipts.ready(),ensureDeletionRequestSchema(database),ensureWriteBarrierSchema(database)]);
  return {namespace:database.namespace,board,valueReports,replicas,slackCapture,connectorSecrets,accounts,controls,indexingReceipts,deletionRequests:prefix=>createPostgresDeletionRequests(database,prefix),writeBarrier:scope=>createPostgresWriteBarrier({...scope,database})};
}
