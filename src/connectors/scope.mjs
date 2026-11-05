import {createHash} from 'node:crypto';

export const PIPELINE_VERSION = 'slack-v1';
const SLACK_STREAMS = new Set(['channel_messages', 'messages', 'threads', 'channels', 'users', 'channel_members']);
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = message => { throw Object.assign(new Error(message), {permanent: true}); };
export function validateBinding(binding) {
  if (!binding || binding.provider !== 'slack' || binding.access !== 'team-public') fail('Unsupported connector binding');
  for (const field of ['tenantId', 'connectionId', 'workspaceId']) {
    if (typeof binding[field] !== 'string' || !/^[A-Za-z0-9_:-]{1,200}$/.test(binding[field])) fail('Invalid connector scope');
  }
  const prefix = `raw/v1/source=slack/workspace=${binding.workspaceId}/connection=${binding.connectionId}/`;
  if (binding.rawPrefix !== prefix) fail('Connector prefix does not match its authorized scope');
  return binding;
}
export function authorize(principal, binding) {
  validateBinding(binding);
  if (!principal?.tenantId || principal.tenantId !== binding.tenantId) fail('Connector scope denied');
}
export function objectStream(binding, key) {
  validateBinding(binding);
  if (typeof key !== 'string' || key.length > 1024 || !key.startsWith(binding.rawPrefix)) fail('Source object outside connector scope');
  const match = /^stream=(channel_messages|messages|threads|channels|users|channel_members)\/date=\d{4}-\d{2}-\d{2}\/sync=[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.jsonl\.gz$/.exec(key.slice(binding.rawPrefix.length));
  if (!match) fail('Unsupported Airbyte object path');
  return match[1];
}
/** Select supported streams while preserving scope and selected-path validation.
 * Extra source streams do not make the supported streams unprocessable. */
export function selectedObject(binding, key) {
  validateBinding(binding);
  if (typeof key !== 'string' || key.length > 1024 || !key.startsWith(binding.rawPrefix)) fail('Source object outside connector scope');
  if (!key.endsWith('.jsonl.gz')) return false;
  const stream = /^stream=([A-Za-z0-9_-]+)\//.exec(key.slice(binding.rawPrefix.length));
  if (stream && !SLACK_STREAMS.has(stream[1])) return false;
  objectStream(binding, key);
  return true;
}
export function documentId(binding, kind, sourceId) {
  validateBinding(binding);
  return digest([binding.tenantId, binding.connectionId, binding.workspaceId, kind, sourceId]);
}
export function receiptKey(binding, indexIdentity, key) {
  objectStream(binding, key);
  return `derived/indexing/${PIPELINE_VERSION}/${digest([binding.tenantId, binding.connectionId, indexIdentity])}/${digest(key)}.json`;
}
export function invalidRecord(message) { fail(message); }
