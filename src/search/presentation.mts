import type {Passage} from './types.mjs';
import {createHash} from 'node:crypto';

/** Excerpts are verbatim slices, never summaries. Offsets refer to JS string units. */
export function excerpt(text: string, query: string, size = 800) {
  if (text.length <= size) return {text, excerpt: {start: 0, end: text.length, totalChars: text.length}};
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [])].slice(0, 24);
  const positions = [0];
  // Budget matches per term so repeated navigation cannot consume all anchors
  // before a rarer term that appears near the end of a long tool result.
  for (const term of terms) {
    let matches = 0;
    for (const match of text.matchAll(new RegExp(term, 'giu'))) {
      positions.push(Math.max(0, Math.min(text.length - size, match.index - 120)));
      if (++matches >= 4) break;
    }
  }
  let start = 0, best = -1;
  for (const position of positions) {
    const window = text.slice(position, position + size).toLowerCase();
    const score = terms.reduce((sum, term) => sum + Number(window.includes(term)), 0);
    if (score > best) {best = score; start = position;}
  }
  return {text: text.slice(start, start + size), excerpt: {start, end: start + size, totalChars: text.length}};
}

export function workspaceHit(source: string, hit: Passage, sourceRank?: number) {
  const provenance = source === 'sessions'
    ? {sessionId: hit.sessionId, eventId: hit.eventId, userId: hit.userId, installationId: hit.installationId, harness: hit.harness, kind: hit.kind, role: hit.role, sequence: hit.sequence, chunk: hit.chunk, timestamp: hit.timestamp, receivedAt: hit.receivedAt}
    : source==='memories'?{harness:hit.harness,userId:hit.userId,installationId:hit.installationId,host:hit.host,path:hit.path,project:hit.project,
      snapshotId:hit.snapshotId,generation:hit.generation,modifiedAt:hit.modifiedAt,receivedAt:hit.receivedAt,sourceSessionId:hit.sourceSessionId,chunk:hit.chunk,kind:hit.kind}
    : {provider: hit.provider, connectionId: hit.connectionId, workspaceId: hit.workspaceId, sourceId: hit.sourceId, kind: hit.kind, parentId: hit.parentId, parentKind: hit.parentKind, channelId: hit.channelId, authorId: hit.authorId, timestamp: hit.timestamp, sequence: hit.sequence, heading: hit.heading, repository:hit.repository};
  return {id: source + ':' + hit.id, source, ...(sourceRank ? {sourceRank} : {}),
    ...(typeof hit.chunkCount==='number'?{passage:{index:hit.chunk,count:hit.chunkCount,start:hit.textStart,end:hit.textEnd}}:{}),
    title: (hit.title || (source === 'sessions' ? `Session ${hit.sessionId}` : hit.kind) || 'Indexed passage').slice(0, 240),
    text: hit.text || '', ...(hit.url ? {url: hit.url} : {}), provenance};
}

/** Conservative grouping: preserve different resources, roles, values and wording.
 * Counts describe this candidate window only. Originals remain individually fetchable.
 */
export function groupDuplicates(hits: WorkspaceHit[]) {
  const groups = new Map<string, WorkspaceHit>(), results: WorkspaceHit[] = [];
  for (const hit of hits) {
    // Preserve indentation and line breaks: whitespace can change code meaning.
    const p = hit.provenance, normalized = hit.text.replace(/\r\n/g, '\n').replace(/[\t ]+$/gm, '').replace(/\n+$/, '');
    const scope = hit.source === 'sessions'
      ? [p.sessionId, p.userId, p.installationId, p.harness, p.kind, p.role]
      : hit.source==='memories'?[p.harness,p.userId,p.installationId,p.path,p.snapshotId]
      : [p.provider, p.connectionId, p.workspaceId, p.parentKind || p.kind, p.parentId || p.sourceId];
    // Empty and very short messages often carry meaning through their occurrence.
    const key = normalized.length >= 80 ? JSON.stringify([hit.source, scope, createHash('sha256').update(normalized).digest('hex')]) : hit.id;
    const existing = groups.get(key);
    if (existing) {
      existing.duplicateCount = (existing.duplicateCount || 0) + 1;
      existing.duplicateIds ||= [];
      if (existing.duplicateIds.length < 3) existing.duplicateIds.push(hit.id);
    } else {const group = {...hit}; groups.set(key, group); results.push(group);}
  }
  return {results, suppressed: hits.length - results.length};
}

export type WorkspaceHit = ReturnType<typeof workspaceHit> & {duplicateCount?: number; duplicateIds?: string[]};

export function groupResources(hits:WorkspaceHit[], mode:'none'|'resource'|'session') {
  if(mode==='none')return {results:hits,suppressed:0};
  const seen=new Map<string,WorkspaceHit&{groupedCount?:number;groupedIds?:string[]}>(),results:Array<WorkspaceHit&{groupedCount?:number;groupedIds?:string[]}>=[];
  for(const hit of hits){
    const p=hit.provenance;
    const key=JSON.stringify(hit.source==='sessions'?[hit.source,p.userId,p.harness,p.sessionId,...(mode==='session'?[]:[p.eventId||hit.id])]:
      hit.source==='memories'?[hit.source,p.userId,p.harness,p.installationId,p.path,p.snapshotId]:
      [hit.source,p.provider,p.connectionId,p.parentKind||p.kind,p.parentId||p.sourceId||hit.id]);
    const existing=seen.get(key);
    if(existing){existing.groupedCount=(existing.groupedCount||0)+1;existing.groupedIds??=[];if(existing.groupedIds.length<3)existing.groupedIds.push(hit.id);}
    else {const copy={...hit};seen.set(key,copy);results.push(copy);}
  }
  return {results,suppressed:hits.length-results.length};
}
