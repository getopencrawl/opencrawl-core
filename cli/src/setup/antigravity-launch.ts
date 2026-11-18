import type {SetupUi} from './tui.tsx';

/** Antigravity 1.5 authenticates plugin servers inside its interactive /mcp menu. */
export async function launchAntigravitySetup(
  executable: string,
  server: string,
  prompt: string,
  needsLogin: boolean,
  ui: Pick<SetupUi, 'action' | 'signal'>,
  execute: (command: string, args: string[]) => Promise<number>,
): Promise<number> {
  if (needsLogin) {
    const choice = await ui.action({
      title: 'Connect Antigravity',
      description: 'In Antigravity, enter /mcp and select this workspace.',
      details: [
        server,
        'If connected, continue to the verification task. For a sign-in request, follow the browser instructions in Antigravity.',
        ...(server.endsWith('_opencrawl')?['If your version lists this connection under /plugin, open '+server.slice(0,-'_opencrawl'.length)+' and choose Sign in.']:[]),
        'When connected, close the menu with Esc and enter /quit. Setup will open your saved task.',
      ],
      actions: [{id: 'open', label: 'Open Antigravity'}, {id: 'close', label: 'Close'}],
    });
    if (choice !== 'open') return 2;
    const code = await execute(executable, []);
    if (code !== 0 || ui.signal.aborted) return code || 130;
  }
  return execute(executable, ['--prompt-interactive', prompt]);
}
