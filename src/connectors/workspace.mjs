import {digest, invalidRecord} from './scope.mjs';
import {id, text, time, richText, people, resource} from './documents.mjs';

function propertyValue(p) {
  const v = p?.[p.type];
  switch (p?.type) {
    case 'title': case 'rich_text': return richText(v);
    case 'number': case 'checkbox': return v == null ? '' : String(v);
    case 'url': case 'email': case 'phone_number': return text(v);
    case 'select': case 'status': return text(v?.name);
    case 'multi_select': return (v || []).map(x => text(x.name)).join(', ');
    case 'people': return people(v).join(', ');
    case 'date': return [text(v?.start), text(v?.end)].filter(Boolean).join(' – ');
    case 'relation': return (v || []).map(x => id(x.id)).join(', ');
    case 'formula': return v ? propertyValue(v) : '';
    case 'string': return text(v);
    case 'rollup': return v?.type === 'array' ? v.array.map(propertyValue).filter(Boolean).join(', ') : v ? propertyValue(v) : '';
    case 'created_time': case 'last_edited_time': return text(v);
    case 'created_by': case 'last_edited_by': return people([v || {}]).join(', ');
    case 'unique_id': return v ? `${v.prefix || ''}${v.number}` : '';
    // Link labels only; signed attachment URLs and binary bodies are excluded.
    case 'files': return (v || []).map(x => text(x.name)).join(', ');
    default: return '';
  }
}
function pageFields(d) {
  const entries = Object.entries(d.properties || {});
  return {title: entries.filter(([, p]) => p.type === 'title').map(([, p]) => propertyValue(p)).join(' '),
    propertiesText: entries.map(([name, p]) => `${name}: ${propertyValue(p)}`).join('\n')};
}
function timestamp(value) {
  if (value == null) invalidRecord('Transcript is missing sequencing time');
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return {sort: value, label: String(value)};
  const label = text(value);
  if (/^\d+(?:\.\d+)?$/.test(label)) return {sort: Number(label), label};
  if (/^\d{1,3}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(label)) return {sort: label.split(':').reduce((a, n) => a * 60 + Number(n), 0), label};
  const sort = Date.parse(label);
  if (!Number.isFinite(sort)) invalidRecord('Invalid transcript time');
  return {sort, label};
}

/** Collate immutable source snapshots before chunking, so S3 rotation and retries
 * cannot change passage boundaries. Only the newest source revision is retained.
 * Memory and inventory caps fail visibly; no partial snapshot gets acknowledged. */
export function workspaceAccumulator(binding) {
  const records = new Map(), transcripts = new Map();
  let retainedBytes = 0;
  function keep(map, key, value) {
    retainedBytes += Buffer.byteLength(JSON.stringify(value)) - (map.has(key) ? Buffer.byteLength(JSON.stringify(map.get(key))) : 0);
    if (retainedBytes > 128 * 1024 * 1024) invalidRecord('Workspace snapshot exceeds 128 MiB; partition this connection before retrying');
    map.set(key, value);
  }
  function latest(a, b) {return !a || b.version > a.version || (b.version === a.version && (b.at > a.at || (b.at === a.at && digest(b.data) > digest(a.data))));}
  return {
    add(stream, envelope, key) {
      const d = envelope._airbyte_data, at = envelope._airbyte_extracted_at;
      if (stream === 'transcripts') {
        const parent = id(d.note_id ?? d.meeting_id);
        const version = time(d.note_updated_at ?? d.meeting_updated_at, at);
        const old = transcripts.get(parent);
        if (old && old.version > version) return;
        if (!old || old.version < version) transcripts.set(parent, {version, lines: new Map()});
        const group = transcripts.get(parent), start = timestamp(d.start_time ?? d.timestamp);
        const speaker = typeof d.speaker === 'string' ? d.speaker : text(d.speaker?.name || d.speaker?.display_name || d.speaker?.email);
        const line = {text: text(d.text), speaker, startTime: start.label, endTime: d.end_time == null ? start.label : timestamp(d.end_time).label, sort: start.sort, at, key};
        const identity = digest([line.startTime, speaker, line.text]);
        if (!group.lines.has(identity) || group.lines.get(identity).at < at) keep(group.lines, identity, line);
        return;
      }
      const sourceId = id(d.id), version = time(d.last_edited_time ?? d.page_last_edited_time ?? d.updated_at ?? d.updatedAt, at);
      const value = {data: d, at, version, key};
      const identity = stream + ':' + sourceId;
      if (latest(records.get(identity), value)) keep(records, identity, value);
    },
    *documents() {
      if (binding.provider === 'notion') {
        for (const [identity, record] of records) {
          const {data: d, at, version, key} = record;
          if (identity.startsWith('pages:')) {
            const fields = pageFields(d), content = records.get('page_markdown:' + d.id);
            if (content && (content.data.truncated === true || content.data.unknown_block_ids?.length)) invalidRecord('Notion markdown is incomplete');
            const body = [fields.propertiesText, text(content?.data.markdown)].filter(Boolean).join('\n\n');
            yield* resource(binding, {kind: 'page', sourceId: id(d.id), title: fields.title, body,
              extractedAt: Math.max(at, content?.at || 0), sourceKey: content?.key || key,
              metadata: {url: text(d.url), componentCount: content ? 2 : 1, versionAt: Math.max(version, content?.version || 0), summary: fields.propertiesText}});
          } else if (identity.startsWith('data_sources:')) {
            const definitions = Object.entries(d.properties || {}).map(([name, p]) => `${name}: ${text(p.type)}`).join('\n');
            yield* resource(binding, {kind: 'database', sourceId: id(d.id), title: richText(d.title),
              body: [richText(d.description), definitions].filter(Boolean).join('\n'), extractedAt: at, sourceKey: key,
              metadata: {url: text(d.url), versionAt: version}});
          } else if (identity.startsWith('comments:')) {
            const pageId = id(d.page_id || d.parent?.page_id);
            const parent = records.get('pages:' + pageId);
            if (!parent) invalidRecord('Notion comment is missing its page metadata');
            yield* resource(binding, {kind: 'comment', sourceId: id(d.id), title: pageFields(parent.data).title,
              body: richText(d.rich_text), extractedAt: at, sourceKey: key,
              metadata: {relatedId: pageId, discussionId: text(d.discussion_id), authorId: text(d.created_by?.id), versionAt: version, url: text(parent.data.url)}});
          } else if (identity.startsWith('page_markdown:') && !records.has('pages:' + d.id)) invalidRecord('Notion markdown is missing page metadata');
        }
      } else {
        const stream = binding.provider === 'granola' ? 'notes' : 'meetings';
        for (const [identity, {data: d, at, version, key}] of records) {
          if (!identity.startsWith(stream + ':')) continue;
          const sourceId = id(d.id), group = transcripts.get(sourceId);
          const lines = [...(group?.lines.values() || [])].sort((a, b) => a.sort - b.sort || a.speaker.localeCompare(b.speaker) || a.text.localeCompare(b.text));
          const actions = (d.actionItems || []).map(x => [text(x.title || x.text), text(x.description), text(x.status), text(x.assignee?.name || x.assigneeName), text(x.dueDate)].filter(Boolean).join(' — '));
          const body = [text(d.summary_markdown || d.summary_text || d.notes), ...actions].filter(Boolean).join('\n');
          yield* resource(binding, {kind: 'meeting', sourceId, title: text(d.title || d.name), body, units: lines, forceChunks: true,
            extractedAt: lines.reduce((max, l) => Math.max(max, l.at), at), sourceKey: key,
            metadata: {componentCount: lines.length + 1, versionAt: Math.max(version, group?.version || 0), url: text(d.web_url || d.url), timestamp: text(d.created_at || d.createdAt), speakers: people(d.attendees)}});
        }
        for (const parent of transcripts.keys()) if (!records.has(stream + ':' + parent)) invalidRecord('Transcript is missing meeting metadata');
      }
    },
  };
}
