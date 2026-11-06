import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
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


test('decoder failures finish upstream cancellation before rejecting and leave no background reads', async () => {
  const consumerError = new Error('Consumer rejected record');
  const invalidUtf8 = Buffer.concat([Buffer.from('{"_airbyte_data":{"text":"'), Buffer.from([0xc3]), Buffer.from('"},"_airbyte_extracted_at":1}\n')]);
  const cases = [
    {bytes: gzipSync(JSON.stringify(envelope('valid')) + '\n'), consume: () => {throw consumerError;}, error: e => e === consumerError},
    {bytes: gzipSync(invalidUtf8), error: /UTF-8/},
    {bytes: gzipSync(JSON.stringify(envelope('x'.repeat(200))) + '\n'), options: {maxExpanded: 100}, error: /Expanded source exceeds/},
    {bytes: Buffer.from('invalid gzip stream'), error: /Invalid gzip/},
  ];
  for (const fixture of cases) {
    let closed = false, reads = 0;
    const trailing = gzipSync(JSON.stringify(envelope('unread')) + '\n');
    const activeStore = {async *read() {
      try {
        yield fixture.bytes;
        for (let i = 0; i < 1000; i++) {await setImmediate(); reads++; yield trailing;}
      } finally {
        // Real adapters may await body cancellation or release a network lease.
        await setImmediate(); closed = true;
      }
    }};
    await assert.rejects(readRecords(activeStore, 'fixture', fixture.consume || (() => assert.fail('invalid source consumed')), fixture.options), fixture.error);
    assert.equal(closed, true, 'source cleanup must finish before rejection');
    assert.ok(reads < 1000, 'a failed consumer must cancel the remaining source');
    const stoppedAt = reads;
    await setImmediate(); await setImmediate();
    assert.equal(reads, stoppedAt, 'no source work may escape the rejected operation');
  }
});
