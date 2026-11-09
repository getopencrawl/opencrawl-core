export class ConsoleApiError extends Error {
  constructor(message: string, readonly status: number) {super(message); this.name = 'ConsoleApiError';}
}

export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The action couldn’t finish. Please try again.';
}

/** Redirect targets come from trusted server adapters, but never execute a script URL. */
export function externalTarget(value: string, origin = window.location.origin): string {
  const target = new URL(value, origin);
  if (target.protocol !== 'https:' && target.origin !== origin) throw new Error('The sign-in link is invalid. Please try again.');
  if (!['https:', 'http:'].includes(target.protocol)) throw new Error('The sign-in link is invalid. Please try again.');
  return target.href;
}
