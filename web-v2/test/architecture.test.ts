import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join, relative} from 'node:path';
import {inspectSource} from '../tools/architecture.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
async function files(path: string): Promise<string[]> {const entries = await readdir(path, {withFileTypes: true}); return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]))).flat();}

test('features cannot fork controls, navigation, inline styling or internal browser links', () => {
  const errors = inspectSource('src/pages/drift.tsx', `export const View=()=> <nav><button style={{color:'red'}}>Save</button><a href="/team">Team</a></nav>;`);
  assert.deepEqual(new Set(errors.map(error => error.rule)), new Set(['single-navigation', 'shared-controls', 'design-tokens', 'spa-navigation']));
  assert.equal(inspectSource('src/pages/good.tsx', `export const View=()=> <Section><Button>Save</Button><Link to="/team">Team</Link></Section>;`).length, 0);
});

test('production source obeys the shared component and TypeScript boundaries', async () => {
  const sourceFiles = await files(join(root, 'src'));
  assert.deepEqual(sourceFiles.filter(file => /\.[cm]?jsx?$/.test(file)), [], 'Author TypeScript only. Compiled output belongs in dist.');
  const violations = (await Promise.all(sourceFiles.filter(file => /\.tsx?$/.test(file)).map(async file => inspectSource(relative(root, file), await readFile(file, 'utf8'))))).flat();
  assert.deepEqual(violations, [], violations.map(value => `${value.file}:${value.line} ${value.message}`).join('\n'));
  for (const file of sourceFiles.filter(file => file.endsWith('.css'))) {
    const name = relative(root, file);
    assert.ok(name.startsWith('src/design/') || name === 'src/styles.css' || name === 'src/onboarding/onboarding.css', `Feature CSS must live in the shared design system: ${name}`);
    if (name === 'src/design/tokens.css' || name === 'src/onboarding/onboarding.css') continue;
    const css = await readFile(file, 'utf8');
    assert.equal(/#[0-9a-f]{3,8}\b|\brgba?\s*\(/i.test(css), false, `Use semantic color tokens in ${name}`);
  }
});
