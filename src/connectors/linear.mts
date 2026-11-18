import type {AirbyteEnvelope, ConnectorBinding} from './types.mjs';
import {linearId, linearUrl, type LinearContext} from '../integrations/linear-access.mjs';
import {LINEAR_KINDS} from '../integrations/linear-upstream.mjs';
import {invalidRecord} from './scope.mjs';
import {resource, text, time} from './documents.mjs';

export function linearResourceId(stream: string, data: Record<string, unknown>): string {
  const kind = LINEAR_KINDS[stream];
  if (!kind) invalidRecord('Invalid Linear stream');
  linearId(data.id);
  if (stream === 'issue_history') {linearId(data.issueId); return `${kind}:${data.issueId}:${data.id}`;}
  return `${kind}:${data.id}`;
}
const opaque = new Set(['descriptionState', 'contentState', 'bodyData']);
const prose = new Set(['description', 'content', 'body']);
const label = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase());

/** Airbyte records stay intact in raw storage; only live-authorized resources enter search. */
export function normalizeLinear(binding: ConnectorBinding, stream: string, envelope: AirbyteEnvelope, key: string, context: LinearContext) {
  if (binding.provider !== 'linear' || !context || !Array.isArray(context.lines)) invalidRecord('Linear access proof required');
  const data = envelope._airbyte_data;
  const sourceId = linearResourceId(stream, data), kind = LINEAR_KINDS[stream];
  const title = [typeof data.identifier === 'string' ? data.identifier : '', typeof data.title === 'string' ? data.title : typeof data.name === 'string' ? data.name : ''].filter(Boolean).join(': ') || context.title || label(kind);
  const lines = [...context.lines];
  for (const [field, value] of Object.entries(data)) {
    if (value === null || value === undefined || opaque.has(field) || ['title', 'name', 'identifier', 'url'].includes(field)) continue;
    if (prose.has(field)) {lines.push(text(value)); continue;}
    if (typeof value === 'object' && !Object.keys(value).length) continue;
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    if (rendered) lines.push(`${label(field)}: ${text(rendered)}`);
  }
  const url = context.url || (typeof data.url === 'string' ? data.url : '');
  return resource(binding, {kind, sourceId, title: text(title), body: text(lines.filter(Boolean).join('\n')),
    extractedAt: envelope._airbyte_extracted_at, sourceKey: key,
    metadata: {url: url ? linearUrl(url) : '', versionAt: time(typeof data.updatedAt === 'string' ? data.updatedAt : typeof data.createdAt === 'string' ? data.createdAt : undefined, envelope._airbyte_extracted_at), normalizerVersion: 2,
      authorId: typeof data.userId === 'string' ? data.userId : typeof data.actorId === 'string' ? data.actorId : typeof data.creatorId === 'string' ? data.creatorId : ''}});
}
