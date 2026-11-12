import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import type {PayloadHarness} from './payload.ts';

/** Where each agent keeps the configuration this collector writes into. The
 * directories follow the agents' own rules, including the variables that move
 * them, so capture lands where the agent will read it. */
export function agentRoots(home: string, env: NodeJS.ProcessEnv = process.env): Record<PayloadHarness, string> {
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  return {
    // OpenCode's global directory. OPENCODE_CONFIG_DIR only adds a second one,
    // read by the processes started with it; the global one is always read.
    opencode: join(config, 'opencode'),
    // Cursor reads this path whatever CURSOR_CONFIG_DIR or XDG_CONFIG_HOME say.
    cursor: join(home, '.cursor'),
    muse: join(config, 'muse'),
  };
}

const COMMANDS: Record<PayloadHarness, string[]> = {opencode: ['opencode'], cursor: ['cursor-agent'], muse: ['muse']};
/** Further signs that an agent is used on this machine when its command is not
 * on PATH: a cloud workspace may run it from a bundled SDK or a private path. */
const TRACES: Record<PayloadHarness, (home: string, env: NodeJS.ProcessEnv) => string[]> = {
  opencode: (home, env) => [join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode'), join(home, '.opencode')],
  cursor: () => [],
  muse: (home, env) => [join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'muse')],
};

/** How an agent's command is looked up. Tests replace it, so a run does not
 * depend on which agents the developer has installed. */
export const agentCommands = {which: (name: string, env: NodeJS.ProcessEnv): string | null => Bun.which(name, {PATH: env.PATH ?? ''})};

/** The agents beyond Claude Code and Codex found on this machine. A plain
 * install records these too; it never creates configuration for one that is
 * not here. */
export function detectAgents({home, env = process.env, which = (name: string) => agentCommands.which(name, env)}: {home: string; env?: NodeJS.ProcessEnv; which?: (name: string) => string | null}): PayloadHarness[] {
  const roots = agentRoots(home, env);
  return (Object.keys(roots) as PayloadHarness[]).filter(harness =>
    existsSync(roots[harness]) || TRACES[harness](home, env).some(path => existsSync(path)) || COMMANDS[harness].some(command => Boolean(which(command))));
}

/** OpenCode installs its plugin support package, about 60 MB, into its
 * configuration directory before it loads any plugin: a few seconds the first
 * time when it can reach the npm registry, and about a minute on every start
 * when it cannot. Capture must not cost a locked-down machine that minute, so
 * the install pays the first-time cost itself and learns whether it works.
 *
 * `ready`: the package is there. `unavailable`: OpenCode ran and could not
 * install it. `unknown`: OpenCode's command is not on this machine yet. */
export type OpenCodeSupport = 'ready' | 'unavailable' | 'unknown';
export function prepareOpenCode(root: string, {env = process.env, timeoutMs = 45_000}: {env?: NodeJS.ProcessEnv; timeoutMs?: number} = {}): OpenCodeSupport {
  const installed = () => existsSync(join(root, 'node_modules', '@opencode-ai', 'plugin', 'package.json'));
  if (installed()) return 'ready';
  const command = agentCommands.which('opencode', env);
  if (!command) return 'unknown';
  // Reads the configuration and installs what the plugins in it need. It
  // starts no session and calls no model.
  spawnSync(command, ['debug', 'config'], {stdio: 'ignore', timeout: timeoutMs, env, windowsHide: true});
  return installed() ? 'ready' : 'unavailable';
}
