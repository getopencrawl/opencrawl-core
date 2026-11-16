import {test, expect} from 'bun:test';
import {copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertSameFile} from '../scripts/file-identity.ts';

const node = Bun.which('node');
if (!node) throw new Error('Node is required for the native file-identity tests.');
function fixture(run: (root: string, file: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'opencrawl-file-identity-'));
  try {
    const parent = join(root, 'long parent name'); mkdirSync(parent);
    const file = join(parent, 'opencrawl.exe'); writeFileSync(file, 'identical fixture bytes');
    run(root, file);
  } finally { rmSync(root, {recursive: true, force: true}); }
}

test('Node identity accepts the same regular file and a real parent alias', () => fixture((root, file) => {
  const alias = join(root, 'alias');
  symlinkSync(join(root, 'long parent name'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const identity = assertSameFile(node, join(alias, 'opencrawl.exe'), file);
  expect(BigInt(identity.dev)).toBeGreaterThan(0n);
  expect(BigInt(identity.ino)).toBeGreaterThan(0n);
  expect(assertSameFile(node, file, file)).toEqual(identity);
}));

test('Node identity accepts a hardlink but rejects a distinct byte-identical copy', () => fixture((root, file) => {
  const link = join(root, 'hardlink.exe'), copy = join(root, 'copy.exe');
  linkSync(file, link); copyFileSync(file, copy);
  expect(readFileSync(copy).equals(readFileSync(file))).toBe(true);
  expect(assertSameFile(node, link, file)).toEqual(assertSameFile(node, file, file));
  expect(() => assertSameFile(node, copy, file)).toThrow('same native executable');
}));

test('Node identity refuses directories and absent targets', () => fixture((root, file) => {
  expect(() => assertSameFile(node, root, file)).toThrow('Node file-identity probe failed');
  expect(() => assertSameFile(node, join(root, 'missing.exe'), file)).toThrow('ENOENT');
}));
