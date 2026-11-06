import {digest, documentId, invalidRecord} from './scope.mjs';

export function text(value) {
  if (value == null) return '';
  if (typeof value !== 'string' || Buffer.byteLength(value) > 8 * 1024 * 1024) invalidRecord('Invalid or oversized connector text');
  return value;
}
export function id(value) {
  if (Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !value || value.length > 500 || /[\x00-\x1f]/.test(value)) invalidRecord('Missing or invalid resource identity');
  return value;
}
export function time(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalidRecord('Invalid resource timestamp');
  return parsed;
}
export const richText = values => (values || []).map(v => text(v.plain_text ?? v.text?.content)).join('');
export const people = values => (values || []).map(v => text(v.name || v.display_name || v.email || v.login)).filter(Boolean);
// Model-independent estimate, bounded for long words and non-Latin scripts too.
const tokens = value => Math.max(1, Math.ceil(Buffer.byteLength(value) / 4), Math.ceil(value.split(/\s+/u).length * 1.3));

/** Sentence/turn aware passages. Oversized sentences alone are split on words.
 * Units carry speaker/timing/heading context through overlap and long turns. */
export function passages(units, target = 512, overlap = 100) {
  const atoms = [];
  for (const unit of units) {
    const sentences = text(unit.text).match(/[^.!?\n]+(?:[.!?]+(?:\s|$)|\n|$)|[^\n]+/gu) || [];
    for (const sentence of sentences) {
      let part = '';
      for (const word of sentence.match(/\S+\s*/gu) || []) {
        // Handle uninterrupted URLs/identifiers without exceeding the passage budget.
        for (const piece of word.match(/.{1,400}/gsu) || []) {
          if (part && tokens(part + piece) > target) {atoms.push({...unit, text: part.trim()}); part = '';}
          part += piece;
        }
      }
      if (part.trim()) atoms.push({...unit, text: part.trim()});
    }
  }
  const result = [];
  for (let start = 0; start < atoms.length;) {
    let end = start, cost = 0;
    while (end < atoms.length && (end === start || cost + tokens(atoms[end].text) <= target)) cost += tokens(atoms[end++].text);
    const group = atoms.slice(start, end);
    result.push({text: group.map(a => (a.speaker ? a.speaker + ': ' : '') + a.text).join('\n'),
      startTime: group[0].startTime || '', endTime: group.at(-1).endTime || group.at(-1).startTime || '',
      speakers: [...new Set(group.map(a => a.speaker).filter(Boolean))], heading: group[0].heading || ''});
    if (end === atoms.length) break;
    let next = end, shared = 0;
    while (next > start + 1 && shared + tokens(atoms[next - 1].text) <= overlap) shared += tokens(atoms[--next].text);
    start = next;
  }
  return result;
}
export function markdownUnits(body) {
  const headings = [];
  return text(body).split('\n').filter(Boolean).map(line => {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) {headings.length = match[1].length - 1; headings[match[1].length - 1] = match[2];}
    return {text: line, heading: headings.filter(Boolean).join(' > ')};
  });
}

export function document(binding, kind, sourceId, fields) {
  const doc = {tenantId: binding.tenantId, connectionId: binding.connectionId, workspaceId: binding.workspaceId,
    provider: binding.provider, kind, sourceId: id(sourceId), title: '', text: '', deleted: false, ...fields};
  doc.contentHash = digest({...doc, sourceKey: undefined});
  return {id: documentId(binding, kind, sourceId), document: doc};
}

/** Children first, parent last: the parent is the published resource revision.
 * Old chunks remain stored but cannot pass retrieval's current-parent check. */
export function resource(binding, {kind, sourceId, title = '', body = '', units, metadata = {}, extractedAt, sourceKey, forceChunks = false}) {
  const chunks = passages(units || markdownUnits(body));
  const split = forceChunks || chunks.length > 1;
  const revision = digest({kind, sourceId, title, body, chunks, metadata});
  const base = {title, extractedAt, sourceKey, ...metadata, resourceVersion: revision};
  const children = split ? chunks.map((chunk, sequence) => document(binding, kind === 'meeting' ? 'transcript' : 'passage',
    `${sourceId}:${revision}:${sequence}`, {...base, ...chunk, parentId: sourceId, parentKind: kind, sequence, chunkCount: chunks.length,
      text: [title, chunk.heading, chunk.text].filter(Boolean).join('\n')})) : [];
  const parent = document(binding, kind, sourceId, {...base, chunkCount: split ? chunks.length : 0,
    text: [title, split && kind !== 'meeting' ? text(metadata.summary) : body].filter(Boolean).join('\n')});
  return [...children, parent];
}
