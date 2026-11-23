import type {SetupUi} from './tui.tsx';

/** Antigravity 1.5 authenticates plugin servers inside its interactive /mcp menu. */
export async function launchAntigravitySetup(
  executable: string,
  server: string,
  prompt: string,
  signInMenu: 'mcp' | 'plugin' | undefined,
  ui: Pick<SetupUi, 'action' | 'signal'>,
  execute: (command: string, args: string[]) => Promise<number>,
): Promise<number> {
  if (signInMenu) {
    const choice = await ui.action({
      title: 'Connect Antigravity',
      description: signInMenu==='plugin'
        ? 'Open /plugin, select '+server.slice(0,-'_opencrawl'.length)+', and choose Sign in.'
        : 'Open /mcp, select '+server+', and sign in if prompted.',
      details: ['Once connected, press Esc and type /quit to continue setup.'],
      actions: [{id: 'open', label: 'Open Antigravity'}, {id: 'close', label: 'Close'}],
    });
    if (choice !== 'open') return 2;
    const code = await execute(executable, []);
    if (code !== 0 || ui.signal.aborted) return code || 130;
  }
  return execute(executable, ['--prompt-interactive', prompt]);
}
