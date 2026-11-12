import {test,expect} from 'bun:test';
import {tmpdir} from 'node:os';
import {resolve,sep} from 'node:path';
import {agentRoots,detectAgents} from '../src/capture/agents.ts';

test('a test run starts away from the developer\'s own capture configuration, agent directories and installed agents',()=>{
  // Undefined when the tests were started from a directory without bunfig.toml.
  // Run `bun test cli` from the repository root, or `bun test` in cli/.
  const isolation=(globalThis as any).opencrawlCliTestIsolation as {scratch:string,defaults:Record<string,string>}|undefined;
  expect(isolation).toBeDefined();
  expect(resolve(isolation!.scratch).startsWith(resolve(tmpdir())+sep)).toBe(true);
  expect(Object.keys(isolation!.defaults).sort()).toEqual(['CLAUDE_CONFIG_DIR','CODEX_HOME','HOME','OPENCRAWL_CONFIG_HOME','USERPROFILE','XDG_CACHE_HOME']);
  for(const path of Object.values(isolation!.defaults))expect(resolve(path).startsWith(resolve(isolation!.scratch)+sep)).toBe(true);
  // A CLI started by a test inherits this home directory, so every directory a
  // plain install there would look in or write to is inside the throwaway one,
  // and no agent is found there. The runtime fixes its own home directory at
  // startup: a test that installs in-process passes its fixture's directory.
  const home=process.env.HOME!;
  expect(home).toBe(isolation!.defaults.HOME);
  for(const root of Object.values(agentRoots(home)))expect(resolve(root).startsWith(resolve(isolation!.scratch)+sep)).toBe(true);
  expect(detectAgents({home})).toEqual([]);
  const child=Bun.spawnSync([process.execPath,'-e','console.log(require("node:os").homedir())'],{env:{...process.env},stdout:'pipe'});
  expect(resolve(child.stdout.toString().trim())).toBe(resolve(home));
});
