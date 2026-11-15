import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

interface PackedFile {path: string; size: number}

export function verifyPackageFiles(files: PackedFile[]): void {
  for (const name of ['app.js', 'app.css', 'callback.js', 'callback.css']) {
    const path = 'web-v2/dist/selfhost/' + name;
    assert(files.some(file => file.path === path && file.size > 0), 'Core package is missing self-host asset: ' + path);
  }
}

if (import.meta.main) {
  // Inspect npm's real inclusion rules without recursively invoking prepack.
  const result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  })) as Array<{files: PackedFile[]}>;
  assert.equal(result.length, 1);
  verifyPackageFiles(result[0]!.files);
}
