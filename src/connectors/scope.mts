import type {ConnectorBinding, ConnectorPrincipal, Provider} from './types.mjs';
import {createHash} from 'node:crypto';

export const PIPELINE_VERSION = 'slack-v6';
export const PROVIDER_STREAMS: Record<Provider, string[]> = {
  slack: ['canonical_messages', 'file_documents', 'channel_messages', 'messages', 'threads', 'channels', 'users', 'channel_members'],
  granola: ['notes', 'transcripts'], circleback: ['meetings', 'transcripts'],
  notion: ['pages', 'page_markdown', 'data_sources', 'comments'],
  github: ['commits', 'pull_requests', 'issues', 'issue_comments', 'review_comments', 'commit_comments', 'releases'],
  googledrive: ['workspace_documents'],
};
export const pipelineVersion = (binding: ConnectorBinding) => binding.provider === 'slack' ? PIPELINE_VERSION : binding.provider === 'googledrive' ? 'drive-workspace-v1' : binding.provider === 'circleback' ? 'workspace-v2' : 'workspace-v1';
export const digest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function fail(message: string): never { throw Object.assign(new Error(message), {permanent: true}); }
export function validateBinding(binding: ConnectorBinding) {
  if (!binding || !Object.hasOwn(PROVIDER_STREAMS, binding.provider) || binding.access !== (binding.provider === 'slack' ? 'team-public' : 'workspace-global')) fail('Unsupported connector binding');
  for (const field of ['tenantId', 'connectionId', 'workspaceId'] as const) {
    if (typeof binding[field] !== 'string' || !/^[A-Za-z0-9_:-]{1,200}$/.test(binding[field])) fail('Invalid connector scope');
  }
  if (binding.provider === 'googledrive' && binding.workspaceId !== binding.tenantId) fail('Drive workspace must match its authorized team');
  const prefix = `raw/v1/source=${binding.provider}/workspace=${binding.workspaceId}/connection=${binding.connectionId}/`;
  if (binding.rawPrefix !== prefix) fail('Connector prefix does not match its authorized scope');
  return binding;
}
export function authorize(principal: ConnectorPrincipal, binding: ConnectorBinding) {
  validateBinding(binding);
  if (!principal?.tenantId || principal.tenantId !== binding.tenantId) fail('Connector scope denied');
}
export function objectStream(binding: ConnectorBinding, key: string) {
  validateBinding(binding);
  if (typeof key !== 'string' || key.length > 1024 || !key.startsWith(binding.rawPrefix)) fail('Source object outside connector scope');
  const match = /^stream=([A-Za-z0-9_-]+)\/date=\d{4}-\d{2}-\d{2}\/sync=[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.jsonl\.gz$/.exec(key.slice(binding.rawPrefix.length));
  if (!match || !PROVIDER_STREAMS[binding.provider].includes(match[1])) fail('Unsupported Airbyte object path');
  return match[1];
}
/** Select supported streams while preserving scope and selected-path validation.
 * Extra source streams do not make the supported streams unprocessable. */
export function selectedObject(binding: ConnectorBinding, key: string) {
  validateBinding(binding);
  if (typeof key !== 'string' || key.length > 1024 || !key.startsWith(binding.rawPrefix)) fail('Source object outside connector scope');
  if (!key.endsWith('.jsonl.gz')) return false;
  const stream = /^stream=([A-Za-z0-9_-]+)\//.exec(key.slice(binding.rawPrefix.length));
  if (stream && !PROVIDER_STREAMS[binding.provider].includes(stream[1])) return false;
  objectStream(binding, key);
  return true;
}
export function documentId(binding: ConnectorBinding, kind: string, sourceId: string) {
  validateBinding(binding);
  return digest([binding.tenantId, binding.connectionId, binding.workspaceId, ...(binding.provider === 'slack' ? [] : [binding.provider]), kind, sourceId]);
}
export function receiptKey(binding: ConnectorBinding, indexIdentity: string, key: string) {
  objectStream(binding, key);
  return `derived/indexing/${pipelineVersion(binding)}/${digest([binding.tenantId, binding.connectionId, indexIdentity])}/${digest(key)}.json`;
}
export function invalidRecord(message: string): never { return fail(message); }
