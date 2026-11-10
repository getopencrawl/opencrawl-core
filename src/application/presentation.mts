import {consoleDocument} from './console.mjs';
export const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self' https://api.workos.com https://*.authkit.app; frame-ancestors 'none'; base-uri 'none'",
  'Strict-Transport-Security': 'max-age=31536000',
};
/** Server adapters supply page data, never HTML content. */
export function document<T extends {kind:string}>(page:T, {signedIn=false}={}) {
  return consoleDocument({page,signedIn});
}
