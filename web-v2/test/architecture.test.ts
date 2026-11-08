import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join, relative} from 'node:path';
import {inspectAuthoredFiles, inspectSource, inspectUiText} from '../tools/architecture.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
async function files(path: string): Promise<string[]> {const entries = await readdir(path, {withFileTypes: true}); return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]))).flat();}

test('features cannot fork controls, navigation, inline styling or internal browser links', () => {
  const errors = inspectSource('src/pages/drift.tsx', `export const View=()=> <nav><button style={{color:'red'}}>Save</button><a href="/team">Team</a></nav>;`);
  assert.deepEqual(new Set(errors.map(error => error.rule)), new Set(['single-navigation', 'shared-controls', 'design-tokens', 'spa-navigation']));
  assert.equal(inspectSource('src/pages/good.tsx', `export const View=()=> <Section><Button>Save</Button><Link to="/team">Team</Link></Section>;`).length, 0);
});

test('centered-dot separators cannot return as UI literals, HTML entities or Unicode escapes', () => {
  const dot = String.fromCodePoint(0xb7);
  const forms = [dot, '&middot;', '&CenterDot;', '&#183;', '&#0183;', '&#xB7;', '&#x00b7;', '\\u00B7', '\\u{B7}', '\\xB7'];
  for (const form of forms) {
    const source = `export const View=()=> <p>Plan ${form} Active</p>;`;
    assert.ok(inspectSource('src/pages/drift.tsx', source).some(error => error.rule === 'no-centered-dot-separators'), form);
  }
  assert.equal(inspectUiText('styles.css', `.status::before {content:'${dot}'}`).length, 1);
  assert.deepEqual(inspectSource('src/pages/good.tsx', 'export const View=()=> <StatusBadge><Icon name="check"/>Active</StatusBadge>;'), []);
});

test('JavaScript is rejected in UI source, tooling, tests and shared assets', () => {
  const javascript = ['src/pages/drift.jsx', 'tools/build.mjs', 'test/browser.js', '../web/copy.cjs'];
  const typescriptAndAssets = ['src/pages/view.tsx', 'tools/build.ts', 'test/browser.ts', '../web/tokens.css', '../web/assets/mark.svg'];
  const violations = inspectAuthoredFiles([...javascript, ...typescriptAndAssets]);
  assert.deepEqual(violations.map(item => item.file), javascript);
  assert.ok(violations.every(item => item.rule === 'typescript-only'));
});

test('authored UI source, tooling, tests and shared assets contain no JavaScript', async () => {
  const authored = (await Promise.all(['src', 'tools', 'test', '../web'].map(path => files(join(root, path))))).flat();
  const violations = inspectAuthoredFiles(authored.map(file => relative(root, file)));
  assert.deepEqual(violations, [], violations.map(item => `${item.file}: ${item.message}`).join('\n'));
});

test('production source obeys the shared component and styling boundaries', async () => {
  const sourceFiles = await files(join(root, 'src'));
  const violations = (await Promise.all(sourceFiles.filter(file => /\.tsx?$/.test(file)).map(async file => inspectSource(relative(root, file), await readFile(file, 'utf8'))))).flat();
  assert.deepEqual(violations, [], violations.map(value => `${value.file}:${value.line} ${value.message}`).join('\n'));
  for (const file of sourceFiles.filter(file => file.endsWith('.css'))) {
    const name = relative(root, file);
    assert.ok(name.startsWith('src/design/') || name === 'src/styles.css' || name === 'src/onboarding/onboarding.css', `Feature CSS must live in the shared design system: ${name}`);
    const css = await readFile(file, 'utf8');
    assert.deepEqual(inspectUiText(name, css), [], `Do not encode separator dots in ${name}`);
    if (name === 'src/design/tokens.css' || name === 'src/onboarding/onboarding.css') continue;
    assert.equal(/#[0-9a-f]{3,8}\b|\brgba?\s*\(/i.test(css), false, `Use semantic color tokens in ${name}`);
  }
});

test('shared web assets and HTML-producing source do not contain separator dots', async () => {
  const shared = [...await files(join(root, '../web')), join(root, '../src/sessions/cloud-setup.mts')];
  for (const file of shared.filter(value => /\.(?:css|html?|[cm]?[jt]sx?)$/.test(value))) {
    assert.deepEqual(inspectUiText(relative(root, file), await readFile(file, 'utf8')), [], file);
  }
});
