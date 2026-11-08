import type {NativeConnectionOptions} from '@temporalio/worker';
import type {PipelineOptions, ConnectorSearch} from '../types.mjs';
import type {FileCaptureOptions, CaptureRun, ReferenceRun, CaptureStepResult} from '../capture-types.mjs';
import type {ConnectorSegmentInput} from '../workflow.mjs';
export interface ConnectionReference {tenantId: string; connectionId: string}
export interface ResolvedConnector extends PipelineOptions {search: ConnectorSearch & {ensureIndex(): Promise<unknown>}}
export type ConnectorActivityInput = ConnectorSegmentInput & ConnectionReference;
export interface ConnectorActivityOptions {resolve: (input: ConnectorActivityInput) => Promise<ResolvedConnector>}
export interface WorkerConnectionOptions {address: string; namespace: string; taskQueue: string; bundlePath: string; connectionOptions?: NativeConnectionOptions}
export interface ConnectorWorkerOptions extends WorkerConnectionOptions, ConnectorActivityOptions {maxConcurrentActivityTaskExecutions?: number}
export interface ResolvedSlackSource extends FileCaptureOptions {sourceIdentity?: string}
export type SourceInput = ConnectionReference & (CaptureRun | ReferenceRun);
export interface SourceActivityOptions {resolve: (input: SourceInput) => Promise<ResolvedSlackSource>}
export interface SourceWorkerOptions extends WorkerConnectionOptions, SourceActivityOptions {}
export interface SourceActivities {
 captureFilePage(input: ConnectionReference & CaptureRun): Promise<CaptureStepResult>;
 captureMessagePage(input: ConnectionReference & CaptureRun): Promise<CaptureStepResult>;
 captureMessageReference(input: ConnectionReference & ReferenceRun): Promise<CaptureStepResult>;
}
