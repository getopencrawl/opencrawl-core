import {expect, test} from 'bun:test';
import {devinEvents, devinSession, devinUnsupported, DEVIN_HOOK_EVENTS} from '../src/capture/devin.ts';

// Synthetic documented contracts. Live Cloud acceptance is a separate gate;
// passing these cases cannot establish which optional fields Cloud emits.
const notice = (fields: Record<string, unknown>, id = 'receipt-1') => ({id, at: '2026-11-15T23:00:00.000Z', sequence: 100,
  event: {session_id: 'devin-synthetic-session', prompt_id: 'turn-2', ...fields}});

test('Devin preserves native session identity across dates and refuses anonymous capture', () => {
  expect(devinSession({session_id: 'devin-synthetic-session', cwd: '/home/ubuntu/task'})).toEqual({sessionId: 'devin-synthetic-session', cwd: '/home/ubuntu/task'});
  for (const session_id of [undefined, '', ' ', '../another-session', 'x'.repeat(201), 123]) {
    expect(() => devinSession({session_id})).toThrow('native session ID');
  }
});

test('Devin indexes explicit user and assistant text, retaining exact whitespace and turn IDs', () => {
  const prompt = devinEvents(notice({hook_event_name: 'UserPromptSubmit', prompt: '  synthetic prompt\n'}))[0]!;
  expect(prompt).toMatchObject({kind: 'message', turnId: 'turn-2', data: {role: 'user', content: [{type: 'text', text: '  synthetic prompt\n'}]}});
  const reply = devinEvents(notice({hook_event_name: 'Stop', last_assistant_message: 'Synthetic answer.'}))[0]!;
  expect(reply).toMatchObject({kind: 'message', turnId: 'turn-2', data: {role: 'assistant', content: [{type: 'text', text: 'Synthetic answer.'}]}});
});

test('missing replies, unknown context and permission hooks remain evidence, never invented chat', () => {
  for (const event of [
    {hook_event_name: 'Stop', stop_hook_active: false},
    {hook_event_name: 'Stop', last_assistant_message: {content: 'unconfirmed shape'}},
    {hook_event_name: 'UserPromptSubmit', prompt: '  '},
    {hook_event_name: 'ContextInput', text: 'an injected peer message'},
    {hook_event_name: 'PermissionRequest', tool_name: 'exec'},
    {hook_event_name: 'PostToolUse', tool_name: 'exec', tool_response: {}},
  ]) expect(devinEvents(notice(event)).map(event => event.kind)).toEqual(['hook']);
  expect(DEVIN_HOOK_EVENTS).not.toContain('PermissionRequest');
  expect(DEVIN_HOOK_EVENTS).not.toContain('SessionEnd');
});

test('repeated tool calls stay distinct while each input and output remain paired', () => {
  const event = {hook_event_name: 'PostToolUse', tool_name: 'exec', tool_input: {command: 'printf synthetic'}, tool_response: {success: true, output: 'synthetic', error: null}};
  const first = devinEvents(notice(event)), second = devinEvents(notice(event, 'receipt-2'));
  expect(first.map(event => event.kind)).toEqual(['tool_call', 'tool_result']);
  expect(first.map(event => event.sequence)).toEqual([100, 101]);
  expect(first[0]!.data.call_id).toBe(first[1]!.data.call_id);
  expect(first[0]!.data.call_id).not.toBe(second[0]!.data.call_id);
  expect(first[0]!.nativeId).toBeNull();
  expect(devinEvents(notice({...event, tool_use_id: 'native-call'}))[0]!.nativeId).toBe('native-call');
  // Replay of a durable notice keeps exactly the same identity and output.
  expect(devinEvents(notice(event))).toEqual(first);
});

test('tool failures retain diagnostics and compaction stays distinct from assistant conversation', () => {
  const result = devinEvents(notice({hook_event_name: 'PostToolUse', tool_name: 'exec', tool_response: {success: false, output: 'partial output', error: 'timeout'}}))[1]!;
  expect(result).toMatchObject({kind: 'tool_result', data: {output: {output: 'partial output', error: 'timeout'}, is_error: true}});
  expect(devinEvents(notice({hook_event_name: 'PostCompaction', summary: 'Synthetic compacted history'}))[0]).toMatchObject({kind: 'compaction', data: {summary: 'Synthetic compacted history'}});
});

test('oversize receipts remain bounded even when identifying fields themselves are oversized', () => {
  const event = {hook_event_name: 'PostToolUse', session_id: 'session-1', prompt_id: 'x'.repeat(5000), tool_name: 'exec', tool_input: {command: 'y'.repeat(10000)}};
  const kept = devinUnsupported(event, 'too_large', 15000);
  expect(JSON.stringify(kept).length).toBeLessThan(500);
  expect(kept).toMatchObject({session_id: 'session-1', captureStatus: 'too_large', bytes: 15000});
  expect(kept).not.toHaveProperty('tool_input');
  expect(devinEvents(notice(kept))[0]!.kind).toBe('hook');
});
