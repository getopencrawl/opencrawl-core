import {test,expect} from 'bun:test';
import {tmpdir} from 'node:os';
import {resolve,sep} from 'node:path';

test('a test run starts away from the developer\'s own capture configuration and hook files',()=>{
  // Undefined when the tests were started from a directory without bunfig.toml.
  // Run `bun test cli` from the repository root, or `bun test` in cli/.
  const isolation=(globalThis as any).opencrawlCliTestIsolation as {scratch:string,defaults:Record<string,string>}|undefined;
  expect(isolation).toBeDefined();
  expect(resolve(isolation!.scratch).startsWith(resolve(tmpdir())+sep)).toBe(true);
  expect(Object.keys(isolation!.defaults).sort()).toEqual(['CLAUDE_CONFIG_DIR','CODEX_HOME','GROK_HOME','OPENCRAWL_CONFIG_HOME','XDG_CACHE_HOME']);
  for(const path of Object.values(isolation!.defaults))expect(resolve(path).startsWith(resolve(isolation!.scratch)+sep)).toBe(true);
});
