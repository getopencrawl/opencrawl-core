import {test} from 'node:test';
import assert from 'node:assert/strict';
import {memoryTitle} from '../dist/src/memories/titles.mjs';

test('memory titles use existing names and headings instead of rollout metadata', () => {
  const metadata = 'thread_id: 01a1-example\nupdated_at: 2026-11-09\nrollout_path: /private/session.jsonl\ncwd: /repo\n\n';
  assert.equal(memoryTitle('memories/rollout_summaries/2026-10-09T17-09-42-YbgJ-phone_harness.md', metadata + '## Phone Harness evaluation and cloud iPhone onboarding\n\nDetails'), 'Phone Harness evaluation and cloud iPhone onboarding');
  assert.equal(memoryTitle('feedback.md', '---\nname: No unnecessary cd in hooks\ndescription: A much longer explanation\n---\nBody'), 'No unnecessary cd in hooks');
  assert.equal(memoryTitle('feedback.md', '\uFEFF---\r\ntitle: "Keep small PRs"\r\nname: Fallback\r\n---\r\n# Other heading'), 'Keep small PRs');
  assert.equal(memoryTitle('feedback.md', '---\nname: user\ndescription: Alice prefers small PRs\n---\nBody'), 'Alice prefers small PRs');
  assert.equal(memoryTitle('file.md', '---\nname: inference-split-query-vs-operator\n---\nBody'), 'Inference split query vs operator');
  assert.equal(memoryTitle('file.md', '---\nname: inference_split\n---\nBody'), 'inference split');
});

test('memory titles clean filenames when summaries have no useful heading', () => {
  const path = 'memories_v2/rollout_summaries/2026-10-09T20-37-20-8jur-arabian_nights_missing_travel_block_investigation.md';
  assert.equal(memoryTitle(path, 'thread_id: opaque-id\nupdated_at: today\n\nInvestigated a missing travel block.'), 'Arabian nights missing travel block investigation');
  assert.equal(memoryTitle('projects/repo/memory/feedback_short_answers.md', ''), 'Feedback short answers');
  assert.equal(memoryTitle('2026-planning.md', ''), '2026 planning');
  assert.equal(memoryTitle('memories/MEMORY.md', '# Task Group: Calendar work\nOther unrelated groups follow'), 'Memory index');
  assert.equal(memoryTitle('memories_v2/memory_summary.md', 'v1\n\n## User Profile\n\n## Other subjects'), 'Memory summary');
});

test('memory title extraction skips code and generic headings and stays bounded', () => {
  const body = '# Summary\n```md\n# Not the title\n```\n## Task 1: Internal subsection\n## **Calendar** [sync](https://example.com)\n';
  assert.equal(memoryTitle('calendar_sync.md', body), 'Calendar sync');
  assert.equal(memoryTitle('calendar_sync.md', '---\ntitle: >\n  Folded value\n---\n# Calendar sync'), 'Calendar sync');
  assert.equal(memoryTitle('calendar_sync.md', '~~~md\n# Fake heading\n~~~~\n# Real heading'), 'Real heading');
  assert.equal(memoryTitle('calendar_sync.md', 'x'.repeat(16000) + '\n# Outside opening window'), 'Calendar sync');
  const title = memoryTitle('file.md', '# ' + '🧭'.repeat(150));
  assert.equal(Array.from(title).length, 120);
  assert.equal(title.endsWith('…'), true);
  assert.equal(title.includes('\uFFFD'), false);
});
