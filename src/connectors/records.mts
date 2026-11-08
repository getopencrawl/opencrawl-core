import {errorMetadata} from './types.mjs';
import type {ConnectorStore, AirbyteEnvelope} from './types.mjs';
import {createGunzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {invalidRecord} from './scope.mjs';

/** Bounded streaming decoder shared by all provider adapters. */
export async function readRecords<T = Record<string, unknown>>(store: ConnectorStore, key: string, consume: (envelope: AirbyteEnvelope<T>) => unknown | Promise<unknown>, {heartbeat = (_progress: Record<string, number>) => {}, maxExpanded = 1024 * 1024 * 1024} = {}) {
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
  let parts: Uint8Array[] = []; let lineBytes = 0, expanded = 0, records = 0;
  const decoder = new TextDecoder('utf-8', {fatal: true});
  function append(bytes: Uint8Array) {
    lineBytes += bytes.length;
    if (lineBytes > 16 * 1024 * 1024) invalidRecord('Airbyte line exceeds supported size');
    if (bytes.length) parts.push(bytes);
  }
  async function flushLine() {
    const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts, lineBytes);
    parts = []; lineBytes = 0;
    await line(decoder.decode(bytes));
  }
  async function line(value: string) {
    if (!value.trim()) return;
    // GitHub records can carry 4 MiB diffs that are deliberately not indexed.
    if (Buffer.byteLength(value) > 16 * 1024 * 1024) invalidRecord('Airbyte line exceeds supported size');
    let envelope: AirbyteEnvelope<T>;
    try {envelope = JSON.parse(value) as AirbyteEnvelope<T>;} catch {invalidRecord('Invalid Airbyte JSON');}
    if (!envelope?._airbyte_data || typeof envelope._airbyte_data !== 'object' || Array.isArray(envelope._airbyte_data) ||
      !Number.isSafeInteger(envelope._airbyte_extracted_at) || envelope._airbyte_extracted_at < 0) invalidRecord('Invalid Airbyte envelope');
    if (envelope._airbyte_meta?.changes?.length) invalidRecord('Airbyte record contains lossy source changes');
    await consume(envelope); records++;
    if (records % 100 === 0) heartbeat({records});
  }
  try {
    // Own the entire stream lifetime: a validation/consumer failure must close
    // the source and gunzip before this operation rejects, including async cleanup.
    await pipeline(source(), createGunzip(), async output => {
      for await (const bytes of output) {
        expanded += bytes.length;
        if (expanded > maxExpanded) invalidRecord('Expanded source exceeds limit');
        // Scan each decompressed byte once. Large ignored diffs can make a JSONL
        // record several MiB; rescanning/concatenating its prefix on every 16 KiB
        // gunzip chunk makes decoding quadratic in record size.
        let start = 0, end;
        while ((end = bytes.indexOf(10, start)) >= 0) {
          append(bytes.subarray(start, end)); await flushLine(); start = end + 1;
        }
        append(bytes.subarray(start));
      }
      if (lineBytes) await flushLine();
    });
  } catch (error) {
    if (['Z_DATA_ERROR', 'Z_BUF_ERROR', 'ERR_ENCODING_INVALID_ENCODED_DATA'].includes(errorMetadata(error).code || '')) invalidRecord('Invalid gzip or UTF-8 source');
    throw error;
  }
  return {sha256: hash.digest('hex'), records};
}
