'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const source = path.resolve(__dirname, '../../bin/opencrawl.cjs');
const platform = `${process.platform}-${process.arch}`;
function makePackage(directory, version, {launcher = 'module.exports.main = async () => 0;', platformVersion = version} = {}) {
  const packages = path.join(directory, 'node_modules', '@getopencrawl');
  const cli = path.join(packages, 'cli');
  const native = path.join(packages, 'cli-' + platform);
  fs.mkdirSync(path.join(cli, 'bin'), {recursive: true});
  fs.mkdirSync(path.join(native, 'bin'), {recursive: true});
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({name: '@getopencrawl/cli', version}));
  fs.writeFileSync(path.join(cli, 'bin/opencrawl.cjs'), launcher);
  fs.writeFileSync(path.join(native, 'package.json'), JSON.stringify({name: '@getopencrawl/cli-' + platform, version: platformVersion}));
  fs.writeFileSync(path.join(native, 'bin', process.platform === 'win32' ? 'opencrawl.exe' : 'opencrawl'), 'fixture; never executed');
  return cli;
}
module.exports = {makePackage};
if (require.main === module) {
  const [area, name, version, mode = 'update'] = process.argv.slice(2);
  const file = suffix => path.join(area, name + '.' + suffix);
  const mark = (suffix, value = true) => {
    const destination = file(suffix), temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value));
    fs.renameSync(temporary, destination);
  };
  const pause = new Int32Array(new SharedArrayBuffer(4));
  function waitSync(suffix) {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(file(suffix))) {
      if (Date.now() > deadline) throw new Error('Fixture barrier timed out: ' + suffix);
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  // Expose the old stale-recovery interleaving without replacing filesystem
  // operations or PID liveness. Fixed launchers need no PID authority or barrier.
  const kill = process.kill, stale = Number(fs.readFileSync(path.join(area, 'stale-pid')));
  process.kill = function(pid, signal) {
    try {return kill.call(process, pid, signal);}
    catch (error) {
      if (pid === stale && error.code === 'ESRCH') {mark('stale-observed'); waitSync('allow-recovery');}
      throw error;
    }
  };
  if (mode !== 'update') cp.spawnSync = (_node, args) => {
    // npm is the only substituted boundary: actual stage validation, rename,
    // collision handling and cleanup still run in installRelease.
    const stage = args[args.indexOf('--prefix') + 1];
    if (mode === 'install') makePackage(stage, version);
    else fs.mkdirSync(path.join(stage, 'node_modules'), {recursive: true});
    mark('stage-ready'); waitSync('allow-install');
    return {status: mode === 'install' ? 0 : 1};
  };
  const launcher = require(source);
  const run = mode === 'update' ? launcher.update({force: true, root: path.join(area, 'installed'), fetcher: async () => {
    mark('fetch-entered');
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(file('allow-fetch'))) {
      if (Date.now() > deadline) throw new Error('Fixture fetch barrier timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return new Response(JSON.stringify({name: '@getopencrawl/cli', version}));
  }}) : launcher.installRelease(version);
  run.then(result => mark('result', {ok: true, result}), error => mark('result', {ok: false, code: error.code || null, message: error.message}));
}
