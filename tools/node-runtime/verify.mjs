import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createReadStream} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const [expectation, output] = process.argv.slice(2);
assert(['baseline', 'patched'].includes(expectation));
assert.equal(process.platform, 'linux');
assert.equal(process.version, 'v24.22.2');
const official = {x64: '904a6d3484241d466989f9df9ba3aab822b1496191bdb28230eb491a55c32a52',
  arm64: 'b4855de8c4781130b722ceaec9718fed77cca3eed2e5cfc5455e267c0b9ee3b0'};
assert(official[process.arch], 'Release scope is Linux x64 and arm64');
const hash = createHash('sha256');
for await (const chunk of createReadStream(process.execPath)) hash.update(chunk);
const binarySha256 = hash.digest('hex');
const result = createRequire(import.meta.url)('./gzwrite-probe.node').probe();
assert.equal(result.writeFailed, true, 'The actual gzwrite failed on /dev/full');
if (expectation === 'baseline') {
  assert.equal(binarySha256, official[process.arch], 'Inspect the pinned official baseline binary');
  assert.equal(result.externalBufferRetained, true, 'Baseline must reproduce the stale caller-buffer state');
  assert.equal(result.inputReset, false);
  assert.equal(result.followupBytes, -1, 'Do not invoke the unsafe follow-up on the vulnerable baseline');
} else {
  assert.notEqual(binarySha256, official[process.arch], 'A source patch requires a rebuilt binary');
  assert.equal(result.externalBufferRetained, false);
  assert.equal(result.inputReset, true, 'Patched native gz_write resets both caller-buffer fields after failure');
  assert.equal(result.followupBytes, Buffer.byteLength('synthetic follow-up'));
}
const proof = {version: process.version, architecture: process.arch, expectation, binarySha256,
  nativeModuleAbi: process.versions.modules, napiVersion: process.versions.napi,
  sourceUrl: 'https://nodejs.org/dist/v24.22.2/node-v24.22.2.tar.xz',
  sourceSha256: '8fe2ec1723bb9f8d0b683907c82708debbeda64af21cb2aa214c4241eed0a061',
  upstreamFix: 'df84af25dc1942490e1d1c899a07619152a46148',
  patchSha256: '110ff14375733173d8aa54574473424fbd7dfe4b81f1ca34a759c6fe14b15b14', result};
await writeFile(output, JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof));
