import {slackMessageText} from './slack-content.mjs';
import {digest, documentId, invalidRecord, validateBinding} from './scope.mjs';

function required(value, pattern, field) {
  if (typeof value !== 'string' || !pattern.test(value)) invalidRecord(`Invalid Slack ${field}`);
  return value;
}
const slackId = value => required(value, /^[A-Z][A-Z0-9]{1,100}$/, 'ID');
const timestamp = value => required(value, /^\d{1,16}\.\d{1,6}$/, 'timestamp');
function text(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') invalidRecord('Invalid Slack text');
  if (Buffer.byteLength(value) > 256 * 1024) invalidRecord('Slack text exceeds supported size');
  return value;
}

/** Stock Airbyte Slack schema; `messages` also accepts the hosted stream alias. */
export function normalizeSlack(binding, stream, envelope, sourceKey) {
  validateBinding(binding);
  const data = envelope?._airbyte_data;
  const extractedAt = envelope?._airbyte_extracted_at;
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Number.isSafeInteger(extractedAt) || extractedAt < 0) invalidRecord('Invalid Airbyte envelope');
  if (envelope._airbyte_meta?.changes?.length) invalidRecord('Airbyte record contains lossy source changes');
  let kind, sourceId, body, channelId = '', threadTs = '', timestampValue = '', authorId = '', title = '';
  if (['canonical_messages', 'channel_messages', 'messages', 'threads'].includes(stream)) {
    kind = 'message'; channelId = slackId(data.channel_id); timestampValue = timestamp(data.ts);
    sourceId = channelId + ':' + timestampValue;
    threadTs = data.thread_ts ? timestamp(data.thread_ts) : timestampValue;
    authorId = text(data.user || data.bot_id); body = slackMessageText(data);
    // These history snapshots are not a deletion feed. Never infer tombstones.
  } else if (stream === 'channels') {
    kind = 'channel'; sourceId = slackId(data.id); channelId = sourceId;
    title = text(data.name); body = [title, text(data.topic?.value), text(data.purpose?.value)].filter(Boolean).join('\n');
  } else if (stream === 'users') {
    kind = 'user'; sourceId = slackId(data.id);
    title = text(data.real_name || data.name); body = [title, text(data.profile?.display_name)].filter(Boolean).join('\n');
  } else if (stream === 'channel_members') {
    kind = 'membership'; channelId = slackId(data.channel_id); sourceId = channelId + ':' + slackId(data.member_id); body = '';
  } else invalidRecord('Unsupported Slack stream');
  const document = {tenantId: binding.tenantId, connectionId: binding.connectionId, workspaceId: binding.workspaceId,
    provider: 'slack', kind, sourceId, channelId, threadTs, timestamp: timestampValue, authorId, title, text: body,
    extractedAt, deleted: false, sourceKey,
    // Channel visibility is checked again at search time against current metadata.
    publicChannel: kind === 'channel' ? data.is_private === false && data.is_im !== true && data.is_mpim !== true : false,
  };
  // Direct history/replies observations are authoritative over search previews.
  if(stream==='canonical_messages')document.sourceAuthority=1;
  if(kind==='message')document.normalizerVersion=5;
  // Stream aliases/thread-parent duplicates share identity; deterministic tie handling
  // makes equal-time deliveries independent of arrival order.
  document.contentHash = digest({...document, sourceKey: undefined});
  return {id: documentId(binding, kind, sourceId), document};
}
