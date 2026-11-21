import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pluginRelease, replicasPolicy} from '../../src/sessions/plugin-release.mts';

const {repository, ref, packages} = pluginRelease;
const harnesses = ['antigravity', 'claude-code', 'codex', 'cursor'];
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];
assert.equal(repository, 'getopencrawl/opencrawl-plugins');
assert.match(ref, /^[a-f0-9]{40}$/);
const raw = 'https://raw.githubusercontent.com/'+repository+'/'+ref+'/';
async function download(path: string) {
  const response = await fetch(raw+path, {redirect:'error', signal:AbortSignal.timeout(30_000)});
  assert(response.ok, 'Missing pinned file '+path);
  return Buffer.from(await response.arrayBuffer());
}
const catalog = JSON.parse((await download('catalog.json')).toString());
assert.deepEqual(catalog.packages.map((p: {harness:string}) => p.harness).sort(), [...harnesses, 'devin'].sort());
const devin = catalog.packages.find((p: {harness:string}) => p.harness === 'devin');
const cloudManifest = JSON.parse((await download('plugins/devin/.devin-plugin/plugin.json')).toString());
assert.deepEqual(devin, {harness:'devin', name:cloudManifest.name, path:'plugins/devin', version:cloudManifest.version, distribution:'repository'});
assert.deepEqual(cloudManifest.platforms, ['cloud']);
assert.deepEqual(packages.map(p => p.harness).sort(), harnesses);
assert.equal(new Set(packages.map(p => p.version)).size, 1);
for (const pkg of packages) {
  const {name, version, path, harness, capabilities} = pkg;
  assert.deepEqual(catalog.packages.find((p:{harness:string}) => p.harness === harness), {harness,name,path,version,capabilities});
  assert.equal(path, 'plugins/'+harness);
  const caps = JSON.parse((await download(path+'/'+capabilities)).toString());
  assert.equal(pkg.captureAvailable, caps.capture.minimum);
  assert.equal(pkg.daemonHandoff, caps.daemonHandoff);
  assert.equal(pkg.minimumHarnessVersion, caps.minimumHarnessVersion);
  assert(caps.callbacks.length > 0);
  assert.deepEqual(Object.keys(pkg.archives ?? {}).sort(), platforms);
  for (const [platform, archive] of Object.entries(pkg.archives ?? {})) {
    const url: string = 'https://github.com/'+repository+'/releases/download/v'+version+'/opencrawl-'+harness+'-'+version+'-'+platform;
    assert.equal(archive.url, url+'.zip');
    assert.equal(archive.metadataUrl, url+'.json');
    assert.match(archive.sha256, /^[a-f0-9]{64}$/);
    assert.match(archive.metadataSha256, /^[a-f0-9]{64}$/);
  }
}
assert.equal(replicasPolicy.sha256, createHash('sha256').update(await download('scripts/replicas-codex-policy.mjs')).digest('hex'));
console.log('Verified the Devin repository install and four native packages on five platforms at '+ref);
