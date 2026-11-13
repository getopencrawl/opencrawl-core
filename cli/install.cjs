#!/usr/bin/env node
'use strict';
// npm runs Node only during installation. Its command shim subsequently starts
// this platform's executable directly, including on Windows (.exe, no shebang).
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

function install(root = __dirname) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const key = process.platform + '-' + process.arch;
  const name = '@getopencrawl/cli-' + key;
  if (pkg.optionalDependencies?.[name] !== pkg.version) throw new Error('Unsupported platform: ' + key);
  const file = require('node:module').createRequire(path.join(root, 'package.json')).resolve(name + '/package.json');
  const platform = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (platform.name !== name || platform.version !== pkg.version) throw new Error('Platform package version mismatch');
  const source = path.join(path.dirname(file), 'bin', process.platform === 'win32' ? 'opencrawl.exe' : 'opencrawl');
  if (!fs.statSync(source).isFile()) throw new Error('Missing platform executable');
  const destination = path.join(root, 'bin', 'opencrawl.exe');
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    try { fs.linkSync(source, temporary); }
    catch (error) {
      if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_FICLONE);
    }
    if (process.platform !== 'win32') fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, {force: true}); }
}
module.exports = {install};
if (require.main === module) {
  try { install(); }
  catch (error) {
    console.error('OpenCrawl native installation failed: ' + error.message);
    console.error('Use the native installer, or reinstall with optional dependencies and install scripts enabled.');
    process.exitCode = 1;
  }
}
