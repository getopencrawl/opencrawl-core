/** Start Bun with an isolated fallback home before it can cache homedir().
 * Individual fixtures may narrow their paths further; a fixture failure or
 * asynchronous cleanup can never fall back to the operator's real profile. */
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const home=mkdtempSync(join(tmpdir(),'opencrawl-cli-test-home-'));
const env:NodeJS.ProcessEnv={...process.env};
for(const key of Object.keys(env))if(key.startsWith('OPENCRAWL_')&&!key.startsWith('OPENCRAWL_TEST_'))delete env[key];
Object.assign(env,{HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:join(home,'xdg-config'),XDG_CACHE_HOME:join(home,'cache'),XDG_DATA_HOME:join(home,'data'),OPENCRAWL_CONFIG_HOME:join(home,'config'),OPENCRAWL_NO_UPDATE:'1',CLAUDE_CONFIG_DIR:join(home,'claude'),CLAUDE_DESKTOP_CONFIG_DIR:join(home,'claude-desktop'),CODEX_HOME:join(home,'codex'),CURSOR_CONFIG_DIR:join(home,'cursor'),ANTIGRAVITY_HOME:join(home,'antigravity')});
const child=Bun.spawn([process.execPath,'test',...process.argv.slice(2)],{cwd:resolve(import.meta.dir,'..'),env,stdin:'inherit',stdout:'inherit',stderr:'inherit'});
const stop=()=>child.kill('SIGTERM');process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{process.exitCode=await child.exited;}
finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);rmSync(home,{recursive:true,force:true});}
