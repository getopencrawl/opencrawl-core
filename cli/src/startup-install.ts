import {existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, statSync, lstatSync, chmodSync} from 'node:fs';
import {join, dirname, basename, isAbsolute, relative} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {atomicFile, configDir} from './session.ts';
import {commandForSelf} from './capture/runtime.ts';
import {retryWindowsSharing} from './filesystem.ts';

export const startupMarker = 'OpenCrawl session startup';
const quote = (s: string) => process.platform === 'win32' ? '"' + s.replace(/"/g, '""') + '"' : "'" + s.replace(/'/g, "'\\''") + "'";
export type StartupOptions = {home?: string; env?: NodeJS.ProcessEnv; command?: string[]; node?: string; requirementsFile?: string};

/** Inspect the documented system policy without changing it or granting trust.
 * Recognize only an unconditional synchronous invocation of an installed CLI.
 * Other managed sources still require inspection in Codex's native hook UI. */
function managedStartup(file: string) {
  if (!existsSync(file)) return null;
  const policy = Bun.TOML.parse(readFileSync(file, 'utf8')) as any;
  if (policy.features?.hooks === false) return {status: 'disabled', file, managed: true};
  const directory = process.platform === 'win32' ? policy.hooks?.windows_managed_dir : policy.hooks?.managed_dir;
  for (const group of policy.hooks?.SessionStart ?? []) {
    if (group.matcher) continue;
    for (const hook of group.hooks ?? []) {
      if (hook.type !== 'command' || hook.statusMessage !== startupMarker || hook.async === true) continue;
      const command = process.platform === 'win32' ? hook.command_windows ?? hook.command : hook.command;
      const match = typeof command === 'string' && /^(?:exec\s+)?(?:OPENCRAWL_NO_UPDATE=1\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))\s+session\s+start\s+--harness\s+codex$/.exec(command);
      const binary = match && (match[1] || match[2] || match[3]);
      if (!binary || !isAbsolute(binary) || !/^opencrawl(?:-\d+\.\d+\.\d+)?(?:\.exe)?$/.test(basename(binary))) continue;
      if (typeof directory !== 'string' || !isAbsolute(directory)) continue;
      const within = relative(directory, binary);
      if (!within || within.startsWith('..') || isAbsolute(within)) continue;
      const executable = statSync(binary);
      if (!executable.isFile() || process.platform !== 'win32' && !(executable.mode & 0o111)) continue;
      return {status: 'managed', file, managed: true, featuresEnabled: policy.features?.hooks === true};
    }
  }
  if (policy.allow_managed_hooks_only === true) return {status: 'disabled', file, managed: true,
    message: 'Codex permits only administrator-managed hooks; ask the administrator to configure OpenCrawl SessionStart.'};
  return null;
}

/** Own only our synchronous SessionStart entry. Never enable disabled hooks. */
export function startupHooks(clients: string[], action: 'status' | 'install', {home = homedir(), env = process.env, command = commandForSelf(), node = process.env.OPENCRAWL_NODE || Bun.which('node') || '', requirementsFile = process.platform === 'win32' ? join(process.env.ProgramData || 'C:\\ProgramData', 'OpenAI', 'Codex', 'requirements.toml') : '/etc/codex/requirements.toml'}: StartupOptions = {}) {
  return clients.filter(client => ['codex', 'claude-code'].includes(client)).map(client => {
    const root = client === 'codex' ? env.CODEX_HOME || join(home, '.codex') : env.CLAUDE_CONFIG_DIR || join(home, '.claude');
    const file = join(root, client === 'codex' ? 'hooks.json' : 'settings.json');
    try {
      const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const config = before ? JSON.parse(before) : {};
      if (!config || typeof config !== 'object' || Array.isArray(config) || config.hooks !== undefined && (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks))) throw new Error();
      const toml = join(root, 'config.toml');
      const managed = client === 'codex' ? managedStartup(requirementsFile) : null;
      const locallyDisabled = config.disableAllHooks === true || client === 'codex' && existsSync(toml) && (Bun.TOML.parse(readFileSync(toml, 'utf8')) as {features?: {hooks?: boolean}}).features?.hooks === false;
      if (locallyDisabled && !managed?.featuresEnabled) return {client, file, status: 'disabled'};
      if (managed) return {client, ...managed};
      const runner = join(configDir(), 'startup', 'runner.cjs');
      const script = `const command=${JSON.stringify(command)};
const env={...process.env,OPENCRAWL_CONFIG_HOME:${JSON.stringify(dirname(configDir()))}};
let file=command[0],args=command.slice(1);
if(args[0]&&require('node:path').basename(args[0])==='opencrawl.cjs'){env.OPENCRAWL_LAUNCHER=args[0];env.OPENCRAWL_NODE=file;const cli=require(args[0]);file=cli.binary(cli.activeRoot());args=args.slice(1);}
args.push(...process.argv.slice(2));
if(process.platform!=='win32')process.execve(file,[file,...args],env);
else {const r=require('node:child_process').spawnSync(file,args,{stdio:'inherit',windowsHide:true,env});process.exitCode=r.status??1;}
`;
      const hook = {type: 'command', command: (process.platform === 'win32' ? '' : 'exec ') + [node, runner].map(quote).join(' ') + ' session start --harness ' + client,
        timeout: 7, statusMessage: startupMarker};
      const hooks = {...config.hooks};
      for (const [event, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups)) throw new Error();
        hooks[event] = groups.flatMap(group => {
          if (!Array.isArray(group?.hooks)) throw new Error();
          const remaining = group.hooks.filter((entry: any) => entry?.statusMessage !== startupMarker);
          return remaining.length ? [{...group, hooks: remaining}] : [];
        });
        if (!hooks[event].length) delete hooks[event];
      }
      (hooks.SessionStart ??= []).push({hooks: [hook]});
      const current = JSON.stringify(config.hooks) === JSON.stringify(hooks) && existsSync(runner) && readFileSync(runner, 'utf8') === script;
      if (action === 'status') return {client, file, status: current ? 'current' : before ? 'outdated' : 'missing'};
      if (current) return {client, file, status: 'unchanged'};
      if (!node || existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error();
      atomicFile(runner, script);
      // Keep a private recovery copy, original permissions and JSON indentation.
      if (before) atomicFile(join(configDir(), 'startup', 'backups', randomUUID() + '.json'), before);
      const indent = /\n([ \t]+)\S/.exec(before)?.[1] ?? (before && !before.includes('\n') ? '' : '  ');
      const text = JSON.stringify({...config, hooks}, null, indent) + '\n';
      mkdirSync(root, {recursive: true});
      const temp = file + '.' + randomUUID() + '.tmp';
      try {
        writeFileSync(temp, text, {mode: 0o600, flag: 'wx'});
        chmodSync(temp, existsSync(file) ? statSync(file).mode & 0o777 : 0o600);
        retryWindowsSharing(() => renameSync(temp, file));
      } finally {try {unlinkSync(temp);} catch {}}
      return {client, file, status: 'installed'};
    } catch {return {client, file, status: 'error', message: 'Could not install the session startup hook. Check harness configuration and file access, then retry skills install.'};}
  });
}
