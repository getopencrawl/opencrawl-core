import {test,expect} from 'bun:test';
import {setupAgentGuide} from '../src/setup/agent-guide.ts';
import {configDir} from '../src/session.ts';
import {dirname,join} from 'node:path';
import {readFileSync,readdirSync} from 'node:fs';
import {retrievalInstruction} from '../src/retrieval-instruction.ts';
import {participationInstructions} from '../src/board.ts';
import {profileSetupCommand,setupCommandForSelf,formatSetupCommand} from '../src/setup/invocation.ts';
import {skillFiles} from '../src/skills.ts';
import {setupPluginFiles,setupPluginIdentity} from '../src/setup/plugins.ts';

test('setup guides preserve the actual invocation and quote client/server arguments on both shell platforms',()=>{
 const api='https://knowledge.example';
 for(const platform of ['linux','win32'] as const){
  const command=[platform==='win32'?"C:\\Private install's\\opencrawl.cmd":"/private install's/bin/opencrawl"];
  const guide=setupAgentGuide('codex',api,command,platform);
  for(const args of [['setup','hooks','--json'],['setup','status','--local','--json'],['setup','status','--json'],['setup','resume','--json'],['setup'],['verify-installation','--client','codex','--json']]){
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

test('the general skill is the repository plugin skill and continues setup without a checkout-bound guide',()=>{
 const files=skillFiles(),skill=files['SKILL.md'];
 expect(Object.keys(files)).toEqual(['SKILL.md']);
 // One copy: the CLI embeds the Claude Code plugin's skill, and the Codex plugin ships the same bytes.
 for(const client of ['claude-code','codex'])expect(readFileSync(join(import.meta.dir,'../../plugins/opencrawl-sessions',client,'skills/opencrawl/SKILL.md'),'utf8')).toBe(skill);
 expect(skill).toContain(retrievalInstruction);expect(skill).toContain(participationInstructions());
 expect(skill).toContain('this same conversation');
 expect(skill).toContain('opencrawl setup status --local --json');
 expect(skill).toContain('bound CLI command, profile and server');
 expect(skill).toContain('saved plugin, future-recording and history choices');
 expect(skill).toContain('preserve opt-outs and do not repeat the questionnaire');
 expect(skill).not.toContain('references/');
 expect(skill).not.toContain(process.execPath);
 expect(skill).not.toContain(import.meta.dir);
});

test('every generated plugin retains its client-bound setup guide beside the single-file general skill',()=>{
 const api='https://selected.example',command=profileSetupCommand(setupCommandForSelf(),dirname(configDir())),identity=setupPluginIdentity(api);
 for(const client of ['cursor','antigravity'] as const){
  const files=setupPluginFiles(client,api),guide=files['skills/opencrawl-setup/SKILL.md'];
  expect(guide).toBe(setupAgentGuide(client,api,command)+`\nThis plugin is \`${identity.name}\`, bound to ${api}. Use this plugin's native MCP namespace for setup and search; preserve other OpenCrawl deployments.\n`);
  expect(Object.keys(files).filter(name=>name.startsWith('skills/opencrawl/'))).toEqual(['skills/opencrawl/SKILL.md']);
  expect(files['skills/opencrawl/SKILL.md']).toBe(skillFiles()['SKILL.md']);
  expect(guide).toContain('`'+formatSetupCommand(['verify-installation','--client',client,'--json','--api',api],command)+'`');
  expect(guide).not.toMatch(/`opencrawl (setup|verify-installation)/);
  expect(guide).not.toContain('`'+formatSetupCommand(['setup','hooks','--json','--api',api],command)+'`');
 }
});

test('the repository plugins ship no deployment-bound setup guide',()=>{
 for(const client of ['claude-code','codex'])expect(readdirSync(join(import.meta.dir,'../../plugins/opencrawl-sessions',client,'skills'))).toEqual(['opencrawl']);
});
