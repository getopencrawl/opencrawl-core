// Read-only Linux loader inspection. No gzip-file function is invoked.
import {basename} from 'node:path';
import {realpathSync} from 'node:fs';
import {CString, dlopen, ptr} from 'bun:ffi';

if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error('Run on the native Linux architecture.');
}
const libc = dlopen('libc.so.6', {
  // Linux RTLD_DEFAULT is the null handle, unlike macOS's -2 sentinel.
  dlsym: {args: ['i64', 'ptr'], returns: 'ptr'},
  dladdr: {args: ['ptr', 'ptr'], returns: 'i32'},
});
const controls = ['malloc', 'free', 'puts', 'dlsym'];
const candidates = ['zlibVersion', 'gzopen', 'gzdopen', 'gzwrite', 'gzfwrite', 'gzclearerr', 'gzclose'];
const symbols = {};
try {
  for (const name of [...controls, ...candidates]) {
    const cName = Buffer.from(name + '\0');
    const address = libc.symbols.dlsym(0n, ptr(cName));
    if (address === null || address === 0) {
      symbols[name] = {found: false};
      continue;
    }
    // Dl_info is four pointers on these two 64-bit Linux architectures.
    const info = Buffer.alloc(32);
    if (libc.symbols.dladdr(address, ptr(info)) === 0) throw new Error('Symbol provider is unresolved.');
    const filenamePointer = Number(info.readBigUInt64LE(0));
    if (!filenamePointer) throw new Error('Symbol provider has no filename.');
    const filename = String(new CString(filenamePointer));
    const fromExecutable = realpathSync(filename) === realpathSync(process.execPath);
    symbols[name] = {found: true, provider: fromExecutable ? 'cli-executable' : basename(filename)};
  }
  if (controls.some(name => symbols[name]?.found !== true)) throw new Error('Loader controls did not resolve.');
  console.log(JSON.stringify({
    platform: process.platform, architecture: process.arch,
    bun: Bun.version, zlib: process.versions.zlib,
    localEnvironmentRuntimeMode: true, symbols,
    gzipFileFunctionsInvoked: false,
    scope: 'Default export lookup with provider attribution; negative results do not establish absent internal calls or remediation.',
  }));
} finally {
  libc.close();
}
