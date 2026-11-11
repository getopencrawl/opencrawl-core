import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyArchive} from '../tools/package-provenance.mts';

test('immutable reuse verifies archive integrity and embedded source without registry custom fields', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'opencrawl-provenance-test-'));
  try {
    const revision = 'a'.repeat(40), name = '@getopencrawl/opencrawl-core', version = '0.3.6-cd.123.gaaaaaaaaaaaa';
    mkdirSync(join(scratch, 'package'));
    writeFileSync(join(scratch, 'package/package.json'), JSON.stringify({name, version}));
    writeFileSync(join(scratch, 'package/revision.json'), JSON.stringify({revision}));
    const archive = join(scratch, 'package.tgz');
    execFileSync('tar', ['-czf', archive, '-C', scratch, 'package']);
    const metadata = {name, version, dist: {integrity: 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64')}};
    verifyArchive(archive, metadata, revision);
    assert.throws(() => verifyArchive(archive, {...metadata, dist: {integrity: 'sha512-wrong'}}, revision), /integrity/);
    assert.throws(() => verifyArchive(archive, metadata, 'b'.repeat(40)), /source/);
    assert.throws(() => verifyArchive(archive, {...metadata, version: '0.3.6-cd.124.gaaaaaaaaaaaa'}, revision), /version/);
  } finally {rmSync(scratch, {recursive: true, force: true});}
});
