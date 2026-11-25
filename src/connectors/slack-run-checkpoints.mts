import type {ConnectorBinding, ConnectorStore} from './types.mjs';
import {digest, invalidRecord} from './scope.mjs';

export const captureKinds = ['files-v1', 'messages-v1', 'message-references-v1'] as const;
export type CaptureKind = typeof captureKinds[number];
export interface RunCheckpoint {
  bytes: Buffer | null;
  save(bytes: Buffer): Promise<void>;
}
export interface SlackRunCheckpoints {
  open(kind: CaptureKind, runId: string): Promise<RunCheckpoint>;
}

export const checkpointLimit = (kind: CaptureKind) => kind === 'message-references-v1' ? 1024 * 1024 : 16 * 1024 * 1024;
export function validateCheckpoint(binding: ConnectorBinding, kind: CaptureKind, runId: string, bytes: Buffer) {
  if (!captureKinds.includes(kind) || !/^[A-Za-z0-9_-]{1,150}$/.test(runId) || bytes.length > checkpointLimit(kind)) invalidRecord('Invalid Slack checkpoint size or identity');
  const state = JSON.parse(bytes.toString());
  if (state?.version !== 1 || state.scope !== digest(binding) || state.runId !== runId ||
      (kind === 'message-references-v1' ? !/^[a-f0-9]{64}$/.test(state.inputHash) : !Number.isSafeInteger(state.cutoff) || state.cutoff < 0)) invalidRecord('Slack checkpoint scope mismatch');
}

// During a rolling upgrade existing consumers retain their configured object authority.
export async function openSlackCheckpoint(checkpoints: SlackRunCheckpoints | undefined, store: ConnectorStore,
  binding: ConnectorBinding, kind: CaptureKind, runId: string): Promise<RunCheckpoint> {
  if (checkpoints) return checkpoints.open(kind, runId);
  const key = binding.rawPrefix + 'capture/' + kind + '/' + runId + '/state.json';
  return {bytes: await store.get(key, {maxBytes: checkpointLimit(kind)}), async save(bytes) {
    if (bytes.length > checkpointLimit(kind)) invalidRecord('Slack capture checkpoint exceeds limit');
    await store.put(key, bytes, 'application/json');
  }};
}
