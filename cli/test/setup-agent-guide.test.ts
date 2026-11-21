import {test,expect} from 'bun:test';
import {setupAgentGuide} from '../src/setup/agent-guide.ts';
import {configDir} from '../src/session.ts';
import {dirname} from 'node:path';
import {profileSetupCommand,setupCommandForSelf,formatSetupCommand} from '../src/setup/invocation.ts';
import {skillFiles} from '../src/skills.ts';
import {setupPluginFiles} from './fixtures/legacy-plugins/prepare.ts';
import {setupPluginIdentity} from '../src/setup/plugins.ts';

test('setup guides preserve the actual invocation and quote client/server arguments on both shell platforms',()=>{
 const api='https://knowledge.example';
 for(const platform of ['linux','win32'] as const){
  const command=[platform==='win32'?"C:\\Private install's\\opencrawl.cmd":"/private install's/bin/opencrawl"];
  const guide=setupAgentGuide('codex',api,command,platform);
  for(const args of [['setup','hooks','--json'],['setup','status','--local','--json'],['setup','status','--json'],['setup','--yes','--json'],['setup'],['verify-installation','--client','codex','--json']]){
   expect(guide).toContain('`'+formatSetupCommand([...args,'--api',api],command,platform)+'`');
  }
  expect(guide).not.toMatch(/`opencrawl (setup|verify-installation)/);
  expect(guide).toContain('recording is off (forward=false)');
  expect(guide).toContain('complete MCP sign-in and tool proof, expect not_selected');
  expect(guide).toContain('do not require or enable new capture');
  expect(guide).toContain('Preserve skipped history');
  expect(guide).toContain('do not ask again even if server hookTrust still says pending');
  expect(guide).toContain('Keep disabled hooks as intentional opt-outs');
  expect(guide).toContain('native OpenCrawl MCP `installation_status`');
  expect(guide).toContain('same installationId/client and the returned proof.id as proofId');
  expect(guide).toContain('Unavailable CLI access does not block the native MCP path');
  expect(guide).toContain('never shell requests or another client');
  expect(guide).toContain('BOTH proof.state=verified AND mcp.state=authenticated');
  expect(guide).toContain('proof.state=not_selected with mcp.state=observed is sufficient');
  expect(guide).toContain('If they disagree, preserve local recording opt-outs');
  expect(guide).toContain('do not follow a stale capture task or claim completion');
 }
});

test('the condensed general skill points to native setup without embedding a checkout-bound guide',()=>{
 const files=skillFiles(),skill=files['SKILL.md'];
 expect(Object.keys(files)).toEqual(['SKILL.md']);
 expect(skill).toContain('this same conversation');
 expect(skill).toContain("native plugin's opencrawl-setup skill");
 expect(skill).toContain('bound CLI command, profile and server');
 expect(skill).toContain('saved plugin, future-recording and history choices');
 expect(skill).toContain('preserve opt-outs and do not repeat the questionnaire');
 expect(skill).not.toContain('references/');
 expect(skill).not.toContain(process.execPath);
 expect(skill).not.toContain(import.meta.dir);
});

test('canonical setup guidance reads explicit per-client configuration without generated instructions',()=>{
 const api='https://selected.example';
 let previous:string|undefined;
 for(const client of ['claude-code','codex','cursor','antigravity'] as const){
  const files=setupPluginFiles(client,api),guide=files['skills/opencrawl-setup/SKILL.md']!,binding=JSON.parse(files['.opencrawl-binding.json']!);
  expect(binding).toMatchObject({api,client,pluginName:setupPluginIdentity(api).name});
  expect(guide).toContain('.opencrawl-binding.json');expect(guide).toContain('OPENCRAWL_CONFIG_HOME');
  expect(guide).toContain('installation_status');expect(guide).toContain('verify_installation');expect(guide).toContain('native disabled hooks');
  expect(guide).not.toContain(api);expect(guide).not.toContain('app.getopencrawl.com');if(previous)expect(guide).toBe(previous);previous=guide;
  expect(Object.keys(files).filter(name=>name.startsWith('skills/opencrawl/'))).toEqual(['skills/opencrawl/SKILL.md']);
  expect(files['skills/opencrawl/SKILL.md']).toBe(skillFiles()['SKILL.md']);
  const mcp=JSON.parse(files[client==='codex'||client==='claude-code'?'.mcp.json':client==='antigravity'?'mcp_config.json':'mcp.json']!);
  expect(mcp.mcpServers[client==='codex'?binding.pluginName:'opencrawl'].url).toBe(api+'/mcp');
 }
});
