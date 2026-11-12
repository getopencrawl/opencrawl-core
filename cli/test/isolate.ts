// Loaded before every test file (see bunfig.toml here and at the repository
// root). The tests install capture, sign in and edit harness hook files. Each
// fixture points those at its own temporary directory by changing process.env,
// and puts the previous values back when it ends. A test that fails while its
// body is still running puts them back under the next test, which would then
// write to the developer's real capture configuration and hook files. With
// these defaults the value a fixture restores is a throwaway directory too.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const scratch=mkdtempSync(join(tmpdir(),'opencrawl-cli-tests-'));
const defaults={
  OPENCRAWL_CONFIG_HOME:join(scratch,'config'),
  XDG_CACHE_HOME:join(scratch,'cache'),
  CLAUDE_CONFIG_DIR:join(scratch,'claude'),
  CODEX_HOME:join(scratch,'codex'),
  GROK_HOME:join(scratch,'grok'),
};
Object.assign(process.env,defaults);
// What isolation.test.ts checks: fixtures change process.env as they run.
(globalThis as any).opencrawlCliTestIsolation={scratch,defaults};
process.on('exit',()=>{try{rmSync(scratch,{recursive:true,force:true});}catch{}});
