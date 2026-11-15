import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {startupHooks} from '../src/startup-install.ts';
import {searchContextMarker, searchContextMatcher, cursorSearchContextMatcher, antigravitySearchContextMatcher} from '../src/search-context.ts';

test('startup installs one exact search adapter per harness without capture, preserving existing hooks',()=>{
  const home=mkdtempSync(join(tmpdir(),'opencrawl-search-hooks-')), saved=process.env.OPENCRAWL_CONFIG_HOME;
  process.env.OPENCRAWL_CONFIG_HOME=join(home,'config');
  const options={home,env:{},command:[process.execPath,resolve(import.meta.dir,'../src/cli.ts')],requirementsFile:join(home,'requirements.toml')};
  try {
    for(const client of ['codex','claude-code','cursor','antigravity']) {
      const root=join(home,client==='codex'?'.codex':client==='claude-code'?'.claude':client==='cursor'?'.cursor':'.gemini/config');
      mkdirSync(root,{recursive:true});
      const file=join(root,client==='claude-code'?'settings.json':'hooks.json');
      const existing=client==='antigravity'?{'user-hooks':{PreToolUse:[{matcher:'other',hooks:[{type:'command',command:'user-hook'}]}]}}
        :client==='cursor'?{version:1,hooks:{preToolUse:[{command:'user-hook',matcher:'MCP:search'}]}}
        :{hooks:{PreToolUse:[{matcher:'other',hooks:[{type:'command',command:'user-hook'}]}]}};
      writeFileSync(file,JSON.stringify(existing));
      expect(startupHooks([client],'install',options)[0]!.status).toBe('installed');
      const config=JSON.parse(readFileSync(file,'utf8'));
      if(client==='antigravity') {
        expect(config['user-hooks']).toEqual((existing as any)['user-hooks']);
        expect(config['opencrawl-startup'].PreToolUse).toHaveLength(1);
        expect(config['opencrawl-startup'].PreToolUse[0].matcher).toBe(antigravitySearchContextMatcher);
        expect(config['opencrawl-startup'].PreToolUse[0].hooks[0].command).toEndWith('search-context --harness antigravity');
      } else if(client==='cursor') {
        expect(config.hooks.preToolUse[0]).toEqual((existing as any).hooks.preToolUse[0]);
        expect(config.hooks.preToolUse).toHaveLength(2);
        expect(config.hooks.preToolUse[1].matcher).toBe(cursorSearchContextMatcher);
        expect(config.hooks.preToolUse[1].command).toEndWith('search-context --harness cursor');
      } else {
        expect(config.hooks.PreToolUse[0]).toEqual((existing as any).hooks.PreToolUse[0]);
        expect(config.hooks.PreToolUse).toHaveLength(2);
        const installed=config.hooks.PreToolUse[1];
        expect(installed.matcher).toBe(searchContextMatcher);
        expect(installed.hooks[0].statusMessage).toBe(searchContextMarker);
        expect(installed.hooks[0].command).toEndWith('search-context --harness '+client);
        expect(installed.hooks[0].async).toBeUndefined();
      }
      expect(startupHooks([client],'status',options)[0]!.status).toBe('current');
      const before=readFileSync(file,'utf8');
      expect(startupHooks([client],'install',options)[0]!.status).toBe('unchanged');
      expect(readFileSync(file,'utf8')).toBe(before);
    }
    expect(existsSync(join(home,'config','opencrawl','capture'))).toBe(false);
  } finally {
    if(saved===undefined) delete process.env.OPENCRAWL_CONFIG_HOME; else process.env.OPENCRAWL_CONFIG_HOME=saved;
    rmSync(home,{recursive:true,force:true});
  }
});
