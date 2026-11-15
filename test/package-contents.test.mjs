import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyPackageFiles} from '../tools/package-contents.mts';

test('npm includes the self-host console despite nested Git ignores and excludes unrelated output', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'opencrawl-packaging-'));
  try {
    const root = new URL('../', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({name: manifest.name, version: manifest.version, files: manifest.files}));
    mkdirSync(join(scratch, 'web-v2/dist/selfhost'), {recursive: true});
    mkdirSync(join(scratch, 'web-v2/dist/reference'));
    for (const path of ['.gitignore', 'web-v2/.gitignore', 'web-v2/.npmignore', 'web-v2/package.json']) {
      const source = new URL(path, root);
      if (existsSync(source)) copyFileSync(source, join(scratch, path));
    }
    for (const name of ['app.js', 'app.css', 'callback.js', 'callback.css']) writeFileSync(join(scratch, 'web-v2/dist/selfhost', name), 'compiled fixture');
    writeFileSync(join(scratch, 'web-v2/dist/reference/console.js'), 'reference fixture');
    writeFileSync(join(scratch, 'web-v2/.env'), 'PRIVATE_FIXTURE=must-not-pack');
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {cwd: scratch, encoding: 'utf8'}));
    verifyPackageFiles(packed.files);
    assert.ok(!packed.files.some(file => file.path.includes('/reference/') || file.path.endsWith('/.env')));
    assert.throws(() => verifyPackageFiles(packed.files.filter(file => file.path !== 'web-v2/dist/selfhost/app.js')), /missing self-host asset/);
    assert.throws(() => verifyPackageFiles(packed.files.map(file => ({...file, size: 0}))), /missing self-host asset/);
  } finally {rmSync(scratch, {recursive: true, force: true});}
});
