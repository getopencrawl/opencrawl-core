import {existsSync} from 'node:fs';
import {join} from 'node:path';
import type {PayloadHarness} from './payload.ts';

/** Where each agent keeps the configuration this collector writes into. The
 * directories follow the agents' own rules, including the variables that move
 * them, so capture lands where the agent will read it. */
export function agentRoots(home: string, env: NodeJS.ProcessEnv = process.env): Record<PayloadHarness, string> {
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  return {
    opencode: env.OPENCODE_CONFIG_DIR || join(config, 'opencode'),
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
