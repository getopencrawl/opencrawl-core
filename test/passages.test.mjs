import {test} from 'node:test';
import assert from 'node:assert/strict';
import {passages,PASSAGE_CHARS} from '../dist/src/search/passages.mjs';

test('passages partition text exactly, stay within size and end at natural boundaries', () => {
  assert.deepEqual(passages(''), ['']);
  assert.deepEqual(passages('short'), ['short']);
  const text = Array.from({length: 400}, (_, i) => `Sentence ${i} about the deadline moving to April ${i % 30}.` + (i % 7 === 6 ? '\n\n' : ' ')).join('');
  const parts = passages(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.length > 1 && parts.every(p => p.length <= PASSAGE_CHARS && p.length > 0));
  for (const part of parts.slice(0, -1)) assert.match(part, /(\n\n|\n|\. | )$/);
  const words = 'x'.repeat(5000);
  assert.deepEqual(passages(words).map(p => p.length), [2000, 2000, 1000]);
  const emoji = 'a'.repeat(1999) + '😀' + 'b'.repeat(100);
  const split = passages(emoji);
  assert.equal(split.join(''), emoji);
  assert.ok(split.every(p => !/[\uD800-\uDBFF]$/.test(p)));
});
