import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({entryPoints: [join(root, 'src/index.ts')], outfile: join(root, 'dist/index.js'), bundle: true, packages: 'external', format: 'esm', platform: 'browser', target: ['es2022'], jsx: 'automatic', sourcemap: true});
await build({entryPoints: [join(root, 'src/styles.css')], outfile: join(root, 'dist/styles.css'), bundle: true, minify: true, target: ['es2022'], external: ['/assets/*']});
await build({entryPoints: [join(root, 'src/reference/main.tsx')], outfile: join(root, 'dist/reference/console.js'), bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], jsx: 'automatic', minify: true});
