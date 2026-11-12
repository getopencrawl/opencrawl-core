// Loaded before every test file (see bunfig.toml here and at the repository
// root). The tests install capture, sign in and edit agent hook files. Each
// fixture points those at its own temporary directory by changing process.env,
// and puts the previous values back when it ends. A test that fails while its
// body is still running puts them back under the next test, which would then
// write to the developer's real capture configuration and hook files. With
// these defaults the value a fixture restores is a throwaway directory too.
//
// A plain install also records the other agents it finds on the machine, by
// their directories under the home directory and their commands on PATH. A CLI
// that a test starts therefore gets a throwaway home directory as well, and no
// agent command is found unless a test supplies its own lookup: a run must
// neither edit the developer's Cursor, OpenCode or Muse Code configuration nor
// depend on which agents that developer has installed. The runtime fixes its
// own home directory when it starts, so a test that installs in-process passes
// its fixture's directory as `home`, as the existing ones do.
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {agentCommands} from '../src/capture/agents.ts';

const scratch=mkdtempSync(join(tmpdir(),'opencrawl-cli-tests-'));
const home=join(scratch,'home');
mkdirSync(home);
const defaults={
  OPENCRAWL_CONFIG_HOME:join(scratch,'config'),
  XDG_CACHE_HOME:join(scratch,'cache'),
  CLAUDE_CONFIG_DIR:join(scratch,'claude'),
  CODEX_HOME:join(scratch,'codex'),
  HOME:home,
  USERPROFILE:home,
};
Object.assign(process.env,defaults);
// These would move an agent's directory out of the home directory a fixture
// passes in, and so out of that fixture's own temporary directory.
for(const name of ['XDG_CONFIG_HOME','XDG_DATA_HOME','OPENCODE_CONFIG_DIR'])delete process.env[name];
agentCommands.which=()=>null;
// What isolation.test.ts checks: fixtures change process.env as they run.
(globalThis as any).opencrawlCliTestIsolation={scratch,defaults};
process.on('exit',()=>{try{rmSync(scratch,{recursive:true,force:true});}catch{}});
