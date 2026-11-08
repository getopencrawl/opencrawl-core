import type {SlackCaptureOptions, SlackFile} from './types.mjs';
import type {SourceCheckpoint} from './workflow.mjs';
export interface CaptureCursor {cursor: string; paginationProgress?: SourceCheckpoint}
export interface CaptureTarget extends CaptureCursor {done: boolean; error?: string}
export interface ChannelTarget extends CaptureTarget {id: string}
export interface ThreadTarget extends CaptureTarget {channel: string; ts: string}
export interface MessageCheckpoint extends CaptureCursor {
 version: number; scope: string; runId: string; cutoff: number;
 channels: Record<string, ChannelTarget>; threads: Record<string, ThreadTarget>;
 priorChannels?: string[]; listed: boolean; nextDue: Record<string, number>; pages: number; emitted: number;
 errors: {method: string; channel?: string | number | boolean; thread?: string | number | boolean; code: string}[];
}
export interface MessageCatalog {scope: string; channels: string[]}
export interface FileCatalog extends MessageCatalog {files: Record<string, string[]>}
export interface FileChannelTarget {id: string; page: number; done: boolean; error?: string}
export interface FileTarget extends CaptureTarget {id: string; channels: string[]; comments: Record<string, string>}
export interface FileCheckpoint extends CaptureCursor {
 version: number; scope: string; runId: string; cutoff: number;
 channels: Record<string, FileChannelTarget>; files: Record<string, FileTarget>;
 priorChannels: string[]; listed: boolean; nextDue: number; pages: number; emitted: number;
 errors: {method: string; id: string; code: string}[];
}
export interface CaptureRun {runId: string; cutoff: number}
export interface MessageReference {channelId: string; ts: string; threadTs?: string}
export interface ReferenceRun {runId: string; references: MessageReference[]}
export interface ReferenceCheckpoint {
 version: number; scope: string; runId: string; inputHash: string; position: number;
 nextDue: Record<string, number>; pages: number; emitted: number;
 errors: {position: number; method: string; code: string}[];
}
export interface FileCaptureOptions extends SlackCaptureOptions {
 download: (file: SlackFile) => Promise<{bytes: Uint8Array; mediaType: string}>;
}
export interface CaptureStepResult {done: boolean; waitMs?: number; failed?: number; pages?: number; emitted?: number; channels?: number; threads?: number; files?: number; references?: number}
