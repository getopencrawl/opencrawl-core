import {CliError} from './oauth.ts';

// Do not turn sandbox/filesystem failures into advice to discard a valid login.
// Never include the original message: paths or attached data can contain secrets.
export function filesystemError(error: unknown, action = 'access local OpenCrawl files'): unknown {
  if (error instanceof CliError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (!['EPERM', 'EACCES', 'EROFS'].includes(code ?? '')) return error;
  return new CliError('PERMISSION_DENIED', `Permission denied (${code}) while trying to ${action}. Allow the required filesystem access, or run the command outside the sandbox. Token refresh, login, and board state require write access to the OpenCrawl configuration directory.`);
}
