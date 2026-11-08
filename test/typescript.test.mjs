import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';

// A regression guard for source/configuration, in addition to the mandatory
// compiler build and behavior tests. This is not a TypeScript parser.
test('backend source stays TypeScript with strict build and typed package exports', async () => {
  const configuration = JSON.parse(await readFile(new URL('../tsconfig.json', import.meta.url), 'utf8'));
  assert.equal(configuration.compilerOptions.strict, true);
  assert.equal(configuration.compilerOptions.noEmitOnError, true);
  assert.equal(configuration.compilerOptions.declaration, true);
  for (const flag of ['noImplicitAny', 'strictNullChecks', 'strictFunctionTypes', 'useUnknownInCatchVariables']) {
    assert.notEqual(configuration.compilerOptions[flag], false, flag);
  }
  async function inspect(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) await inspect(path);
      else {
        assert.doesNotMatch(entry.name, /\.(?:mjs|cjs|js|jsx)$/, `Plain JavaScript backend source: ${path}`);
        if (!/\.(?:mts|cts|ts)$/.test(entry.name)) continue;
        const source = await readFile(path, 'utf8');
        assert.doesNotMatch(source, /@ts-(?:nocheck|ignore|expect-error)\b/, `Suppressed backend diagnostics: ${path}`);
        assert.doesNotMatch(source, /:\s*any\b|\bas\s+any\b|<any>|\bany\[\]/, `Untyped backend contract: ${path}`);
      }
    }
  }
  await inspect(new URL('../src/', import.meta.url));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (!target.startsWith('./dist/src/')) continue;
    assert.match(target, /\.mjs$/);
    await readFile(new URL('../' + target.replace(/\.mjs$/, '.d.mts'), import.meta.url));
  }
});
