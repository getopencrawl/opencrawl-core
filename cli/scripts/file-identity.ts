import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

type FileIdentity = {dev: string; ino: string};
// The update smoke already requires Node for npm. Use its native filesystem
// identity instead of Bun's Windows realpath spelling or rounded numeric IDs.
const probe = `
const assert = require('node:assert/strict');
const {openSync, fstatSync, closeSync} = require('node:fs');
assert.equal(process.argv.length, 3);
const descriptors = [];
try {
  for (const path of process.argv.slice(1)) descriptors.push(openSync(path, 'r'));
  const identities = descriptors.map(fd => {
    const stat = fstatSync(fd, {bigint: true});
    assert.ok(stat.isFile(), 'Expected a regular file');
    assert.ok(stat.dev > 0n && stat.ino > 0n, 'Filesystem identity unavailable');
    return {dev: stat.dev.toString(), ino: stat.ino.toString()};
  });
  process.stdout.write(JSON.stringify(identities));
} finally { for (const fd of descriptors) closeSync(fd); }
`;

export function assertSameFile(nodeExecutable: string, actual: string, expected: string) {
  const result = spawnSync(nodeExecutable, ['--input-type=commonjs', '-e', probe, actual, expected],
    {encoding: 'utf8', windowsHide: true, timeout: 15_000});
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'Node file-identity probe failed: ' + result.stderr);
  const [observed, wanted] = JSON.parse(result.stdout) as [FileIdentity, FileIdentity];
  assert.deepEqual(observed, wanted, 'Migrated capture must invoke the same native executable');
  return observed;
}
