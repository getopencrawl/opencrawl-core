import {cpSync, existsSync, readdirSync, mkdirSync, rmSync} from 'node:fs';
import {resolve, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(resolve(root, 'dist/src'), {recursive: true, force: true});
const compiler = resolve(root, 'node_modules/.bin/tsc');
const result = spawnSync(compiler, ['--project', 'tsconfig.json'], {cwd: root, stdio: 'inherit'});
if (result.status !== 0) process.exit(result.status ?? 1);
function assets(directory: string): void {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const source = resolve(directory, entry.name);
    if (entry.isDirectory()) assets(source);
    else if (!/\.(?:mts|cts|ts|tsx)$/.test(entry.name)) {
      const target = resolve(root, 'dist', relative(root, source));
      mkdirSync(dirname(target), {recursive: true});
      cpSync(source, target);
    }
  }
}
assets(resolve(root, 'src'));
