import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

/** A Claude Code transcript in the record shapes Claude Code 2.1 writes. All content is invented. */
export function transcriptFixture(session = '11111111-2222-4333-8444-555555555555', start = Date.parse('2026-01-05T08:00:00Z')) {
  let clock = start, records = 0, messages = 0, tools = 0;
  const lines: any[] = [];
  const record = (fields: any) => {
    const entry = {...fields, uuid: `00000000-0000-4000-8000-${String(++records).padStart(12, '0')}`, timestamp: new Date(clock += 1000).toISOString(), sessionId: session, isSidechain: false};
    lines.push(entry);
    return entry as {uuid: string; timestamp: string; [key: string]: any};
  };
  return {
    session, lines,
    /** A message the person typed: a string, or content blocks. */
    user: (content: unknown, extra: object = {}) => record({type: 'user', message: {role: 'user', content}, ...extra}),
    /** A message sent while the agent was working. */
    queued: (prompt: unknown, extra: object = {}) => record({type: 'attachment', attachment: {type: 'queued_command', prompt, commandMode: 'prompt', ...extra}}),
    /** One content block per line, as current versions write an assistant message. */
    assistant: (text: string, id = `msg_${++messages}`) => record({type: 'assistant', message: {id, role: 'assistant', content: [{type: 'text', text}]}}),
    call: (name: string, input: object, id = `msg_${++messages}`) => {
      const toolId = `toolu_${++tools}`;
      return {toolId, entry: record({type: 'assistant', message: {id, role: 'assistant', content: [{type: 'tool_use', id: toolId, name, input}]}})};
    },
    result: (toolId: string, content: unknown) => record({type: 'user', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: toolId, content}]}, toolUseResult: {}}),
    /** A tool call and what it returned. */
    tool(name: string, input: object, output: unknown) {
      const {toolId, entry} = this.call(name, input);
      return {call: entry, result: this.result(toolId, output)};
    },
    /** A compaction: the boundary, then the summary that replaced the conversation. */
    compaction(summary: string, preserved: string[] = []) {
      const boundary = record({type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted',
        compactMetadata: {trigger: 'auto', preTokens: 72_000, postTokens: 12_000, preservedMessages: {anchorUuid: preserved[0], uuids: preserved, allUuids: preserved}}});
      return {boundary, summary: record({type: 'user', message: {role: 'user', content: summary}, isCompactSummary: true, isVisibleInTranscriptOnly: true})};
    },
    /** Claude Code's log of its message queue: a message sent while the agent is busy, and what became of it. */
    queue: (operation: 'enqueue' | 'dequeue' | 'remove' | 'popAll', content?: string, extra: object = {}) => record({type: 'queue-operation', operation, ...(content === undefined ? {} : {content}), ...extra}),
    /** Context a hook put into the conversation. */
    hook: (text: string, hookEvent = 'SessionStart') => record({type: 'attachment', attachment: {type: 'hook_additional_context', content: [text], hookName: hookEvent, hookEvent}}),
    raw: (line: string) => {lines.push(line);},
    write(path: string, {partial = ''} = {}) {
      mkdirSync(dirname(path), {recursive: true});
      writeFileSync(path, lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n' + partial);
      return path;
    },
  };
}

/** The directory name Claude Code gives a project. */
export const projectDirectory = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
