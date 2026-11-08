import type {Principal} from '../sessions/types.mjs';
export interface MemoryFile {path: string; text: string; project: string; modifiedAt: string}
export interface MemorySnapshot {schemaVersion: number; installationId: string; harness: string; generation: number; host: string; owner: Principal; files: MemoryFile[]; receivedAt?: string; snapshotId?: string}
export interface StoredMemorySnapshot extends MemorySnapshot {receivedAt: string; snapshotId: string}
