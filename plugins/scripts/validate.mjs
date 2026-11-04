import assert from 'node:assert/strict';
import {readFile, readdir, lstat} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const pluginFiles = ['.claude-plugin/plugin.json', '.mcp.json', 'LICENSE', 'README.md', 'assets/icon.png', 'mcp.json', 'plugin.json', 'skills/opencrawl/SKILL.md'].sort();
const endpoint = 'https://app.getopencrawl.com/mcp';
export function validateManifests(portable, claude, mcp, claudeMcp) {
  for (const key of ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']) assert.deepEqual(portable[key], claude[key], `Host manifest mismatch: ${key}`);
  assert.equal(portable.name, 'opencrawl');
  assert.match(portable.version, /^\d+\.\d+\.\d+$/);
  assert.equal(portable.license, 'MIT');
  assert.deepEqual(Object.keys(mcp.mcpServers), ['opencrawl']);
  assert.deepEqual(Object.keys(claudeMcp.mcpServers), ['opencrawl']);
  assert.deepEqual(claudeMcp.mcpServers.opencrawl, {type: 'http', url: endpoint});
  assert.deepEqual(mcp.mcpServers.opencrawl, {
    type: 'streamable-http', url: endpoint,
    extensions: {'com.openai': {auth: {type: 'oauth', client: {mode: 'cimd'}, resource: endpoint, baseScopes: ['offline_access']}}},
  });
  assert.equal(portable.extensions['com.openai'].onboardingSkill, './skills/opencrawl/SKILL.md');
  for (const manifest of [portable, claude]) {
    for (const key of ['hooks', 'agents', 'commands', 'apps']) assert.equal(manifest[key], undefined);
  }
  for (const key of ['hooks', 'apps']) assert.equal(portable.extensions['com.openai'][key], undefined);
}
export async function validate(directory = root) {
  const base = resolve(directory, 'opencrawl');
  const read = async path => JSON.parse(await readFile(resolve(base, path), 'utf8'));
  const configs = await Promise.all(['plugin.json', '.claude-plugin/plugin.json', 'mcp.json', '.mcp.json'].map(read));
  validateManifests(...configs);
  const files = [];
  async function walk(path = '') {
    const dir = resolve(base, path);
    assert.equal((await lstat(dir)).isSymbolicLink(), false, `Symlink: ${path}`);
    for (const name of await readdir(dir)) {
      const relative = path ? `${path}/${name}` : name;
      const stat = await lstat(resolve(base, relative));
      assert.equal(stat.isSymbolicLink(), false, `Symlink: ${relative}`);
      if (stat.isDirectory()) await walk(relative);
      else {assert(stat.isFile()); files.push(relative);}
    }
  }
  await walk();
  assert.deepEqual(files.sort(), pluginFiles, 'Unexpected packaged file; review the release allowlist');
  const skill = await readFile(resolve(base, 'skills/opencrawl/SKILL.md'), 'utf8');
  assert(skill.startsWith('---\nname: opencrawl\ndescription: '));
  assert(skill.includes('test_connection'));
  assert((await readFile(resolve(base, 'README.md'), 'utf8')).split(/\s+/).length >= 40);
  assert.equal(await readFile(resolve(directory, 'LICENSE'), 'utf8'), await readFile(resolve(base, 'LICENSE'), 'utf8'));
  const cm = JSON.parse(await readFile(resolve(directory, '.claude-plugin/marketplace.json')));
  const om = JSON.parse(await readFile(resolve(directory, '.agents/plugins/marketplace.json')));
  assert.equal(cm.plugins.length, 1); assert.equal(om.plugins.length, 1);
  assert.equal(cm.plugins[0].source, './opencrawl');
  assert.equal(cm.plugins[0].version, configs[0].version);
  assert.equal(om.plugins[0].source.path, './opencrawl');
  assert.equal(om.plugins[0].policy.authentication, 'ON_INSTALL');
  const png = await readFile(resolve(base, 'assets/icon.png'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20));
  assert(png.readUInt32BE(16) >= 512 && png.readUInt32BE(16) <= 2048);
  assert(png.length < 2_000_000);
  return configs[0].version;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(`Validated OpenCrawl plugin ${await validate()} for both hosts`);
