import type {AirbyteEnvelope, ConnectorBinding} from './types.mjs';
import {LINEAR_POLICY, linearId, linearUrl, type LinearDocument} from '../integrations/linear-source.mjs';
import {digest, invalidRecord} from './scope.mjs';
import {resource, text, time} from './documents.mjs';

export function normalizeLinear(binding: ConnectorBinding, stream: string, envelope: AirbyteEnvelope<LinearDocument>, key: string) {
  const data = envelope._airbyte_data, access = data?.access;
  if (binding.provider !== 'linear' || !['issues', 'comments'].includes(stream) || data?.kind !== (stream === 'issues' ? 'issue' : 'comment') || !data.id?.startsWith(data.kind + ':')) invalidRecord('Invalid Linear stream or identity');
  linearId(data.id.slice(data.kind.length + 1));
  if (typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt)) || typeof data.title !== 'string' || typeof data.text !== 'string') invalidRecord('Invalid Linear content');
  if (!access || access.policy !== LINEAR_POLICY || access.tenantId !== binding.tenantId || access.connectionId !== binding.connectionId || access.workspaceId !== binding.workspaceId ||
    !Number.isSafeInteger(access.checkedAt) || access.checkedAt < 0 || access.checkedAt > envelope._airbyte_extracted_at + 60000 ||
    access.contentHash !== digest({id: data.id, kind: data.kind, title: data.title, text: data.text, url: data.url, updatedAt: data.updatedAt})) invalidRecord('Invalid Linear public-team receipt');
  linearId(access.teamId);
  return resource(binding, {kind: data.kind, sourceId: data.id, title: text(data.title), body: text(data.text), extractedAt: access.checkedAt, sourceKey: key,
    metadata: {url: linearUrl(data.url), versionAt: time(data.updatedAt, access.checkedAt), normalizerVersion: 1}});
}
