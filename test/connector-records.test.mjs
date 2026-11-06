import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {readRecords} from '../src/connectors/records.mjs';

const envelope = text => ({_airbyte_extracted_at: 1, _airbyte_data: {text}});
function store(bytes) {return {async *read() {for (let i = 0; i < bytes.length; i += 37) yield bytes.subarray(i, i + 37);}};}
test('large JSONL records preserve Unicode across gzip chunks, blank lines and an unterminated final line', async () => {
  const rows = [envelope('🌍é'.repeat(900000)), envelope('last line')];
  const compressed = gzipSync(rows.map(JSON.stringify).join('\n\n'));
  const seen = [], result = await readRecords(store(compressed), 'fixture', row => seen.push(row));
  assert.deepEqual(seen, rows); assert.equal(result.records, 2);
  assert.equal(result.sha256, createHash('sha256').update(compressed).digest('hex'));
});
test('oversized lines fail before consumption, both with and without a terminating newline', async () => {
  for (const suffix of ['', '\n']) {
    const compressed = gzipSync(JSON.stringify(envelope('x'.repeat(16 * 1024 * 1024))) + suffix);
    await assert.rejects(readRecords(store(compressed), 'fixture', () => assert.fail('oversized row consumed')), /line exceeds/);
  }
});
test('invalid UTF-8 at the end of a line fails closed', async () => {
  const compressed = gzipSync(Buffer.concat([Buffer.from('{"_airbyte_data":{"text":"'), Buffer.from([0xc3]), Buffer.from('"},"_airbyte_extracted_at":1}\n')]));
  await assert.rejects(readRecords(store(compressed), 'fixture', () => assert.fail('invalid UTF-8 consumed')), /UTF-8/);
});
