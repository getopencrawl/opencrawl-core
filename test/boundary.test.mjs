import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hello, renderHello } from '../dist/src/index.mjs';

const sourceRoot = new URL('../src/', import.meta.url);

// A conservative regression lint for ordinary imports, not a JavaScript parser
// or security sandbox. Review network/configuration coupling independently.
function checkImports(source, file, root = sourceRoot) {
  assert.doesNotMatch(source, /\b(?:import|require(?:\.resolve)?)\s*\(\s*(?!\s*["'])\S/, 'Computed imports need boundary review');
  for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require(?:\.resolve)?\s*\(\s*)["']([^"']+)["']/g)) {
    const specifier = match[1];
    assert.ok(!specifier.includes('\\'), `Escaped dependency needs review: ${specifier}`);
    if (specifier.startsWith('node:') || ['@modelcontextprotocol/server', '@modelcontextprotocol/node', 'zod'].includes(specifier)) continue;
    // Document parsers run only in the bounded, credential-free extraction thread.
    if (file.href.endsWith('/connectors/document-text-worker.mts') && ['parse5', 'pdfjs-dist/legacy/build/pdf.mjs'].includes(specifier)) continue;
    // Temporal is an optional customer-operated adapter, not a domain dependency.
    if ((file.href.includes('/connectors/temporal/') || file.href.includes('/sessions/temporal/')) && ['@temporalio/worker', '@temporalio/activity', '@temporalio/workflow', '@temporalio/common', '@temporalio/client'].includes(specifier)) continue;
    assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `Forbidden core dependency: ${specifier}`);
    assert.ok(new URL(specifier, file).href.startsWith(root.href), `Dependency escapes product runtime: ${specifier}`);
  }
}

async function checkTree(directory, root = directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    assert.ok(!entry.isSymbolicLink(), `Source symlink needs boundary review: ${file}`);
    if (entry.isDirectory()) await checkTree(file, root);
    else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) checkImports(await readFile(file, 'utf8'), file, root);
  }
}

test('core runs without any hosted service or credentials', () => {
  assert.deepEqual(hello(), {message: 'hello world'});
  assert.equal(renderHello(), '<main><h1>hello world</h1></main>');
});

test('core runtime imports stay inside src, Node builtins, or reviewed portable libraries', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  // Reviewed portable MCP SDK/PDF.js (Apache-2.0), schema validation and parse5 (MIT).
  // PDF/HTML parsing is lazy and isolated; no hosted credentials or external fetches.
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@modelcontextprotocol/node', '@modelcontextprotocol/server', 'parse5', 'pdfjs-dist', 'zod']);
  assert.deepEqual(pkg.optionalDependencies || {}, {});
  const temporal = ['@temporalio/activity', '@temporalio/client', '@temporalio/common', '@temporalio/worker', '@temporalio/workflow'];
  assert.deepEqual(Object.keys(pkg.peerDependencies).sort(), temporal);
  for (const name of temporal) {
    assert.equal(pkg.peerDependencies[name], '1.25.0');
    assert.deepEqual(pkg.peerDependenciesMeta[name], {optional: true});
  }
  await checkTree(sourceRoot);
});

test('boundary lint rejects common reverse dependencies and permits internal nesting', () => {
  const nested = new URL('feature/run.mjs', sourceRoot);
  for (const source of [
    `import '@workos-inc/node';`,
    `import sdk from '@workos-inc/node';`,
    `export {sdk} from '@workos-inc/node';`,
    `await import( '@workos-inc/node');`,
    `require('@workos-inc/node');`,
    `require.resolve('@workos-inc/node');`,
    `import '../../server.mjs';`,
    `import '../../integrations/adapter.mjs';`,
    `import('https://hosted.example/control');`,
    `import(provider);`,
    'import(`@workos-inc/node`);',
  ]) assert.throws(() => checkImports(source, nested), undefined, source);
  checkImports(`import {hello} from '../index.mjs'; export {x} from './data.mjs'; import 'node:fs';`, nested);
});


test('boundary lint visits nested source files and ignores non-source assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opencrawl-boundary-'));
  const root = pathToFileURL(directory + '/');
  try {
    await mkdir(new URL('feature/', root));
    await writeFile(new URL('feature/data.json', root), '{}');
    const file = new URL('feature/run.mjs', root);
    await writeFile(file, "import '@workos-inc/node';");
    await assert.rejects(checkTree(root), /Forbidden core dependency/);
    await writeFile(file, "import '../index.mjs';");
    await checkTree(root);
    await writeFile(file, "import '../../shell.mjs';");
    await assert.rejects(checkTree(root), /escapes product runtime/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
