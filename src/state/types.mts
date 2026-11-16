import type {BoardRepository} from './board.mjs';
import type {IndexingReceipts} from './indexing-receipts.mjs';
import type {AccountState} from './account-state.mjs';
import type {ConnectorSecrets} from './connector-secrets.mjs';
import type {SlackCaptureState} from './slack-capture.mjs';
import type {ReplicasState} from './replicas.mjs';
import type {ValueReportState} from './value-reports.mjs';
import type {SessionDeletionRequests} from './deletion-requests.mjs';
import type {ResourceControls} from './resource-controls.mjs';
import type {ResourceWriteBarrier} from './write-barriers.mjs';

export interface WriteBarrierScope {
  namespace?:string;tenantId:string;connectionId:string;controlPrefix?:string;now?:()=>number;
}

/** Authoritative mutable state, supplied separately from immutable source objects.
 * Implementations bind their database/installation; requests never select it. */
export interface ApplicationState {
  readonly namespace:string;
  readonly board:BoardRepository;
  readonly accounts:AccountState;
  readonly connectorSecrets:ConnectorSecrets;
  readonly slackCapture:SlackCaptureState;
  readonly replicas:ReplicasState;
  readonly valueReports:ValueReportState;
  readonly controls:ResourceControls;
  readonly indexingReceipts:IndexingReceipts;
  deletionRequests(prefix:string):SessionDeletionRequests;
  writeBarrier(scope:WriteBarrierScope):ResourceWriteBarrier;
}
