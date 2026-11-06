import {createGunzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {invalidRecord} from './scope.mjs';

/** Bounded streaming decoder shared by all provider adapters. */
export async function readRecords(store, key, consume, {heartbeat = () => {}} = {}) {
  const hash = createHash('sha256');
  async function* source() {
    const input = store.read ? store.read(key, {maxBytes: 256 * 1024 * 1024}) : [await store.get(key, {maxBytes: 256 * 1024 * 1024})];
    let compressed = 0;
    for await (const bytes of input) {
      if (!bytes) throw new Error('Source object is not available');
      compressed += bytes.length;
      if (compressed > 256 * 1024 * 1024) invalidRecord('Source exceeds compressed limit');
      hash.update(bytes); yield bytes;
    }
  }
  let pending = '', expanded = 0, records = 0;
  const decoder = new TextDecoder('utf-8', {fatal: true});
  async function line(value) {
    if (!value.trim()) return;
    // GitHub records can carry 4 MiB diffs that are deliberately not indexed.
    if (Buffer.byteLength(value) > 16 * 1024 * 1024) invalidRecord('Airbyte line exceeds supported size');
    let envelope;
    try {envelope = JSON.parse(value);} catch {invalidRecord('Invalid Airbyte JSON');}
    if (!envelope?._airbyte_data || typeof envelope._airbyte_data !== 'object' || Array.isArray(envelope._airbyte_data) ||
      !Number.isSafeInteger(envelope._airbyte_extracted_at) || envelope._airbyte_extracted_at < 0) invalidRecord('Invalid Airbyte envelope');
    if (envelope._airbyte_meta?.changes?.length) invalidRecord('Airbyte record contains lossy source changes');
    await consume(envelope); records++;
    if (records % 100 === 0) heartbeat({records});
  }
  try {
    for await (const bytes of Readable.from(source()).compose(createGunzip())) {
      expanded += bytes.length;
      if (expanded > 1024 * 1024 * 1024) invalidRecord('Expanded source exceeds limit');
      pending += decoder.decode(bytes, {stream: true});
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {await line(pending.slice(0, end)); pending = pending.slice(end + 1);}
      if (Buffer.byteLength(pending) > 16 * 1024 * 1024) invalidRecord('Airbyte line exceeds supported size');
    }
    await line(pending + decoder.decode());
  } catch (error) {
    if (['Z_DATA_ERROR', 'Z_BUF_ERROR', 'ERR_ENCODING_INVALID_ENCODED_DATA'].includes(error.code)) invalidRecord('Invalid gzip or UTF-8 source');
    throw error;
  }
  return {sha256: hash.digest('hex'), records};
}
