import type {NamedWritePolicy, WritePolicy} from './types.mjs';
import type {SearchDocument} from './types.mjs';

const scripts: Record<NamedWritePolicy,string> = {
  'session-participants': "if (ctx._source.session == null) { ctx.op = 'none'; } else if (ctx._source.tenantId != params.doc.tenantId || ctx._source.session.userId != params.doc.session.userId || ctx._source.session.harness != params.doc.session.harness || ctx._source.session.sessionId != params.doc.session.sessionId || ctx._source.session.eventId != params.doc.session.eventId || ctx._source.session.chunk != 0 || params.doc.session.chunk != 0) { throw new IllegalArgumentException('Session participant ownership mismatch'); } else if (ctx._source.session.containsKey('participantVersion')) { ctx.op = 'none'; } else { for (def key : ['participantVersion','participantId','participantName','participantUnknown']) { if (params.doc.session.containsKey(key)) { ctx._source.session[key] = params.doc.session[key]; } } }",
  'session-tokens': "if (ctx._source.session == null) { ctx.op = 'none'; } else if (ctx._source.tenantId != params.doc.tenantId || ctx._source.session.userId != params.doc.session.userId || ctx._source.session.harness != params.doc.session.harness || ctx._source.session.sessionId != params.doc.session.sessionId || ctx._source.session.eventId != params.doc.session.eventId || ctx._source.session.chunk != 0 || params.doc.session.chunk != 0) { throw new IllegalArgumentException('Session token ownership mismatch'); } else if (ctx._source.session.containsKey('capturedTokens')) { ctx.op = 'none'; } else { ctx._source.session.capturedTokens = params.doc.session.capturedTokens; }",
  'session': "if (ctx._source.session != null && (ctx._source.tenantId != params.doc.tenantId || ctx._source.session.userId != params.doc.session.userId)) { throw new IllegalArgumentException('Session document ownership mismatch'); } if (ctx._source.session == null || ctx._source.session.receivedAt == null || (params.doc.session.containsKey('passageVersion') && (!ctx._source.session.containsKey('passageVersion') || params.doc.session.passageVersion > ctx._source.session.passageVersion)) || params.doc.session.receivedAt.compareTo(ctx._source.session.receivedAt) > 0) { ctx._source = params.doc; } else { ctx.op = 'none'; }",
  'connector': `if (ctx._source.connector == null) { ctx._source = params.doc; }
else if (ctx._source.connector.deleted == true) { ctx.op = 'none'; }
else if (ctx._source.connector.containsKey('sourceAuthority') && (!params.doc.connector.containsKey('sourceAuthority') || params.doc.connector.sourceAuthority < ctx._source.connector.sourceAuthority)) { ctx.op = 'none'; }
else if (params.doc.connector.containsKey('sourceAuthority') && (!ctx._source.connector.containsKey('sourceAuthority') || params.doc.connector.sourceAuthority > ctx._source.connector.sourceAuthority)) { ctx._source = params.doc; }
else if (params.doc.connector.extractedAt == ctx._source.connector.extractedAt && params.doc.connector.containsKey('normalizerVersion') &&
 (!ctx._source.connector.containsKey('normalizerVersion') || params.doc.connector.normalizerVersion > ctx._source.connector.normalizerVersion)) { ctx._source = params.doc; }
else if (params.doc.connector.extractedAt == ctx._source.connector.extractedAt && ctx._source.connector.containsKey('normalizerVersion') &&
 (!params.doc.connector.containsKey('normalizerVersion') || params.doc.connector.normalizerVersion < ctx._source.connector.normalizerVersion)) { ctx.op = 'none'; }
else if (ctx._source.connector.extractedAt == null ||
 (params.doc.connector.containsKey('versionAt') && (!ctx._source.connector.containsKey('versionAt') || params.doc.connector.versionAt > ctx._source.connector.versionAt)) ||
 ((!params.doc.connector.containsKey('versionAt') || params.doc.connector.versionAt == ctx._source.connector.versionAt) &&
 (params.doc.connector.extractedAt > ctx._source.connector.extractedAt ||
 (params.doc.connector.extractedAt == ctx._source.connector.extractedAt && ((params.doc.connector.containsKey('componentCount') && params.doc.connector.componentCount > ctx._source.connector.componentCount) ||
 ((!params.doc.connector.containsKey('componentCount') || params.doc.connector.componentCount == ctx._source.connector.componentCount) && params.doc.connector.contentHash.compareTo(ctx._source.connector.contentHash) > 0)))))) {
 ctx._source = params.doc;
} else { ctx.op = 'none'; }`,
  'memory-head': "if (ctx._source.memory == null || params.doc.memory.generation > ctx._source.memory.generation) { ctx._source = params.doc; } else if (params.doc.memory.generation == ctx._source.memory.generation) { if (params.doc.memory.snapshotId != ctx._source.memory.snapshotId) { throw new IllegalArgumentException('Memory generation conflict'); } if (!ctx._source.memory.containsKey('projectionId') || (params.doc.memory.containsKey('passageVersion') && ctx._source.memory.containsKey('passageVersion') && params.doc.memory.passageVersion > ctx._source.memory.passageVersion)) { ctx._source = params.doc; } else { ctx.op = 'none'; } } else { ctx.op = 'none'; }",
  'session-projection': "if (ctx._source.session == null) { ctx.op = 'none'; } else { ctx._source.text = params.doc.text; ctx._source.session.attachments = params.doc.session.attachments; ctx._source.session.toolNames = params.doc.session.toolNames; }",
};
export function writeScript(policy:WritePolicy):string {
  if(typeof policy!=='string'){
    if(policy?.name!=='memory-projection-rollback'||!/^[a-f0-9]{64}$/.test(policy.expectedProjectionId))throw new Error('Invalid memory projection rollback policy');
    return `if (ctx._source.memory != null && ctx._source.tenantId == params.doc.tenantId && ctx._source.memory.userId == params.doc.memory.userId && ctx._source.memory.snapshotId == params.doc.memory.snapshotId && ctx._source.memory.generation == params.doc.memory.generation && ctx._source.memory.projectionId == ${JSON.stringify(policy.expectedProjectionId)}) { ctx._source = params.doc; } else { ctx.op = 'none'; }`;
  }
  if(!Object.hasOwn(scripts,policy))throw new Error('Unsupported index write policy');
  return scripts[policy];
}
export function patchScript(set:Record<string,unknown>) {
  const fields=Object.keys(set);
  if(!fields.length||fields.some(f=>!['session.private','memory.private','connector.deleted','text','title'].includes(f)))throw new Error('Unsupported index patch');
  return {lang:'painless',source:fields.map((f,i)=>'ctx._source.'+f+' = params.v'+i+';').join(' '),params:Object.fromEntries(fields.map((f,i)=>['v'+i,set[f]]))};
}

/** Equivalent atomic decisions for the named write policies. The SQLite
 * adapter calls this while holding BEGIN IMMEDIATE, including the prior read. */
export function applyWrite(policy: WritePolicy | undefined, previous: SearchDocument | undefined, next: SearchDocument): SearchDocument | null {
  if (!policy) return next;
  writeScript(policy); // Reject unknown policies even on an empty index.
  const corpus = policy === 'connector' ? 'connector' : typeof policy!=='string'||policy === 'memory-head' ? 'memory' : 'session';
  if (next.corpus !== corpus) throw new Error('Index write policy corpus mismatch');
  const before = previous?.[corpus] as Record<string, unknown> | undefined;
  const after = next[corpus] as Record<string, unknown>;
  const number = (d: Record<string, unknown>, key: string) => typeof d[key] === 'number' ? d[key] as number : -Infinity;
  if(typeof policy!=='string')return previous&&before&&previous.tenantId===next.tenantId&&before.userId===after.userId&&before.snapshotId===after.snapshotId&&before.generation===after.generation&&before.projectionId===policy.expectedProjectionId?next:null;
  if (policy === 'session-participants') {
    if (!previous || !before) return null;
    if (previous.tenantId !== next.tenantId || ['userId','harness','sessionId','eventId'].some(key => before[key] !== after[key]) || before.chunk !== 0 || after.chunk !== 0) throw new Error('Session participant ownership mismatch');
    if (Object.hasOwn(before, 'participantVersion')) return null;
    return {...previous, session: {...before, ...Object.fromEntries(['participantVersion','participantId','participantName','participantUnknown'].filter(key => Object.hasOwn(after, key)).map(key => [key, after[key]]))}};
  }
  if (policy === 'session-tokens') {
    if (!previous || !before) return null;
    if (previous.tenantId !== next.tenantId || ['userId','harness','sessionId','eventId'].some(key => before[key] !== after[key]) || before.chunk !== 0 || after.chunk !== 0) throw new Error('Session token ownership mismatch');
    if (Object.hasOwn(before, 'capturedTokens')) return null;
    return {...previous, session: {...before, capturedTokens: after.capturedTokens}};
  }
  if (policy === 'session-projection') {
    if (!previous || !before) return null;
    return {...previous, text: next.text, session: {...before, attachments: after.attachments, toolNames: after.toolNames}};
  }
  if (!before) return next;
  if (policy === 'session') {
    if (previous!.tenantId !== next.tenantId || before.userId !== after.userId) throw new Error('Session document ownership mismatch');
    return before.receivedAt == null || number(after, 'passageVersion') > number(before, 'passageVersion') || String(after.receivedAt) > String(before.receivedAt) ? next : null;
  }
  if (policy === 'memory-head') {
    if (number(after, 'generation') > number(before, 'generation')) return next;
    if (after.generation === before.generation && after.snapshotId !== before.snapshotId) throw new Error('Memory generation conflict');
    if(after.generation===before.generation&&(!Object.hasOwn(before,'projectionId')||typeof after.passageVersion==='number'&&typeof before.passageVersion==='number'&&after.passageVersion>before.passageVersion))return next;
    return null;
  }
  if (before.deleted === true) return null;
  if (number(after, 'sourceAuthority') < number(before, 'sourceAuthority')) return null;
  if (number(after, 'sourceAuthority') > number(before, 'sourceAuthority')) return next;
  if (after.extractedAt === before.extractedAt) {
    if (number(after, 'normalizerVersion') > number(before, 'normalizerVersion')) return next;
    if (number(after, 'normalizerVersion') < number(before, 'normalizerVersion')) return null;
  }
  if (before.extractedAt == null || number(after, 'versionAt') > number(before, 'versionAt')) return next;
  if (after.versionAt === undefined || after.versionAt === before.versionAt) {
    if (number(after, 'extractedAt') > number(before, 'extractedAt')) return next;
    if (after.extractedAt === before.extractedAt && (number(after, 'componentCount') > number(before, 'componentCount') ||
      (after.componentCount === undefined || after.componentCount === before.componentCount) && String(after.contentHash) > String(before.contentHash))) return next;
  }
  return null;
}

export function applyPatch(document: SearchDocument, patch: Record<string, unknown>): SearchDocument {
  patchScript(patch);
  const copy = structuredClone(document);
  for (const [field, value] of Object.entries(patch)) {
    const parts = field.split('.');
    if (parts.length === 1) {
      if (typeof value !== 'string') throw new Error('Invalid text patch');
      copy[field] = value;
    } else {
      if (typeof value !== 'boolean' || parts[0] !== document.corpus) throw new Error('Invalid visibility patch');
      (copy[parts[0]] as Record<string, unknown>)[parts[1]] = value;
    }
  }
  return copy;
}
