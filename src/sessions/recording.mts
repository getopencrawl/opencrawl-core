import type {Principal} from './types.mjs';

export type PauseMode = 'hour' | 'indefinite' | 'resume';
export type PauseWindow = [start: number, end: number | null];
export interface RecordingStatus {revision: string; paused: boolean; until: number | null}
export interface RecordingSignal extends RecordingStatus {observedAt?:number; windows?: PauseWindow[]}
export interface RecordingPolicy {
  read(principal: Principal, knownRevision?: string): Promise<RecordingSignal>;
  wait(principal: Principal, revision: string, signal: AbortSignal): Promise<void>;
  change(principal: Principal, mode: PauseMode, expected: string): Promise<RecordingStatus>;
  capture<T>(principal: Principal, revision: string | undefined, timestamps: readonly unknown[], write: () => Promise<T>): Promise<T>;
}
