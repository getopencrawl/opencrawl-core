import { isAbsolute } from 'node:path';

type Binding = { api: string; configHome: string; installationId: string; registrationId: string };
export function registrationMcp(command: string[], b: Binding) {
  if (!command[0] || !isAbsolute(command[0]) || !isAbsolute(b.configHome))
    throw Error('Invalid agent MCP launcher');
  return {
    command: command[0],
    args: [
      ...command.slice(1),
      'mcp',
      '--api',
      b.api,
      '--installation-id',
      b.installationId,
      '--registration',
      b.registrationId,
    ],
    env: { OPENCRAWL_CONFIG_HOME: b.configHome },
  };
}
export function isRegistrationMcp(value: unknown, api: string, configHome: string): boolean {
  if (
    !value ||
    typeof value !== 'object' ||
    !('command' in value) ||
    typeof value.command !== 'string' ||
    !isAbsolute(value.command) ||
    !('env' in value) ||
    !value.env ||
    typeof value.env !== 'object' ||
    !('OPENCRAWL_CONFIG_HOME' in value.env) ||
    value.env.OPENCRAWL_CONFIG_HOME !== configHome ||
    !('args' in value) ||
    !Array.isArray(value.args)
  )
    return false;
  const [cmd, flag, origin, install, id, registration, subject] = value.args.slice(-7);
  return (
    cmd === 'mcp' &&
    flag === '--api' &&
    origin === api &&
    install === '--installation-id' &&
    typeof id === 'string' &&
    id.length > 0 &&
    registration === '--registration' &&
    typeof subject === 'string' &&
    subject.length > 0
  );
}
