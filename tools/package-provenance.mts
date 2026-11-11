import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';

const PACKAGE = '@getopencrawl/opencrawl-core';
interface Metadata {name: string; version: string; dist: {integrity: string}}

export function verifyArchive(archive: string, metadata: Metadata, expectedRevision: string): void {
  assert.equal(metadata.name, PACKAGE);
  assert(/^[a-f0-9]{40}$/.test(expectedRevision), 'Invalid expected source');
  assert.equal(metadata.dist.integrity, 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64'), 'Package integrity mismatch');
  const read = (path: string): unknown => JSON.parse(execFileSync('tar', ['-xOf', archive, path], {encoding: 'utf8', maxBuffer: 4 * 1024 * 1024}));
  const manifest = read('package/package.json') as {name: string; version: string};
  const revision = read('package/revision.json') as {revision: string};
  assert.equal(manifest.name, PACKAGE);
  assert.equal(manifest.version, metadata.version, 'Published version mismatch');
  assert.equal(revision.revision, expectedRevision, 'Published source mismatch');
  assert(metadata.version.endsWith('.g' + expectedRevision.slice(0, 12)), 'Version source mismatch');
}

if (import.meta.main) {
  const [metadataPath, version, revision] = process.argv.slice(2);
  assert(metadataPath && version && revision, 'Expected metadata file, version and source');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Metadata;
  assert.equal(metadata.version, version);
  const scratch = mkdtempSync(join(tmpdir(), 'opencrawl-package-provenance-'));
  try {
    // GitHub Packages strips custom manifest fields from registry responses.
    // The integrity-bound revision inside the immutable archive is authoritative.
    const packed = JSON.parse(execFileSync('npm', ['pack', PACKAGE + '@' + version, '--ignore-scripts', '--json', '--pack-destination', scratch], {encoding: 'utf8', maxBuffer: 4 * 1024 * 1024})) as Array<{filename: string}>;
    const filename = packed[0]?.filename;
    assert(filename && basename(filename) === filename, 'Invalid package archive');
    verifyArchive(join(scratch, filename), metadata, revision);
  } finally {rmSync(scratch, {recursive: true, force: true});}
}
