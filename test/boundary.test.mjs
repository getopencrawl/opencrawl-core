import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { hello, renderHello } from '../src/index.mjs';

test('core runs without any hosted service or credentials', () => {
  assert.deepEqual(hello(), {message: 'hello world'});
  assert.equal(renderHello(), '<main><h1>hello world</h1></main>');
});

test('core cannot import runtime packages or the private shell', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.deepEqual(pkg.dependencies || {}, {});
  for (const file of await readdir(new URL('../src/', import.meta.url))) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)/g)) {
      assert.ok(match[1].startsWith('node:') || /^\.\/[^/]+$/.test(match[1]), `Forbidden core dependency: ${match[1]}`);
    }
  }
});
