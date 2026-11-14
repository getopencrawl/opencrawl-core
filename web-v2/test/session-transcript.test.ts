import test from 'node:test';
import assert from 'node:assert/strict';
import {capturedSender, transcriptBlocks} from '../src/pages/sessions.js';
import type {TranscriptEvent} from '../src/pages/library-types.js';

test('activity counts retain empty source records and multiple entries in one event', () => {
  const events: TranscriptEvent[] = [
    {eventId: 'empty', kind: 'capture', timestamp: null, entries: []},
    {eventId: 'mixed', kind: 'message', timestamp: null, entries: [
      {type: 'tool_call', name: 'Read', input: 'file', truncated: false},
      {type: 'tool_result', text: 'contents', truncated: false},
      {type: 'message', role: 'assistant', text: 'Complete message'},
    ]},
    {eventId: 'last', kind: 'metadata', timestamp: null, entries: []},
  ];
  const blocks = transcriptBlocks(events);
  assert.deepEqual(blocks.map(block => block.kind), ['activity', 'message', 'activity']);
  assert.equal(blocks[0]?.kind === 'activity' && blocks[0].events.length, 2);
  assert.equal(blocks[0]?.kind === 'activity' && blocks[0].events[1]?.entries.length, 2);
  assert.equal(blocks[2]?.kind === 'activity' && blocks[2].events[0]?.eventId, 'last');
});

test('human attribution uses structured sender facts independently of capture ownership', () => {
  const actor: NonNullable<TranscriptEvent['actor']> = {provider: 'replicas', assurance: 'collector-reported', kind: 'human', workspaceId: 'workspace', nativeId: 'session', messageId: 'message', userId: 'alice', name: 'Alice', email: 'alice@example.test'};
  assert.equal(capturedSender(actor, 'Workspace capture'), 'Alice');
  assert.equal(capturedSender({...actor, name: undefined}, 'Workspace capture'), 'alice@example.test');
  assert.equal(capturedSender({...actor, kind: 'unknown'}, 'Workspace capture'), 'Unknown sender');
  assert.equal(capturedSender(undefined, 'You'), 'You');
  const message: TranscriptEvent = {eventId: 'user', timestamp: null, kind: 'message', actor, entries: [{type: 'message', role: 'user', text: 'From someone else'}]};
  const block = transcriptBlocks([message])[0];
  assert.equal(block?.kind === 'message' && block.actor?.name, 'Alice');
});
