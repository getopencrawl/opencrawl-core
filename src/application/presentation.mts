export const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self' https://api.workos.com https://*.authkit.app; frame-ancestors 'none'; base-uri 'none'",
  'Strict-Transport-Security': 'max-age=31536000',
};
// Auth and provider handoff documents have a focused frame; all workspace navigation is owned by React AppShell.
export function document(content: string | Buffer, {signedIn = false, title = 'OpenCrawl', cloudCapture = false} = {}) {
  const nav = signedIn ? `<nav><form method="post" action="/auth/logout"><button class="quiet">Sign out</button></form></nav>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#000"><title>${title}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="preload" href="/assets/geist-sans.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/frame.css"><link rel="stylesheet" href="/controls.css"><link rel="stylesheet" href="/shell.css">${cloudCapture?'<link rel="stylesheet" href="/cloud-capture.css">':''}</head><body><section class="paper"><header><a class="brand" href="/" aria-label="OpenCrawl home"><img src="/assets/opencrawl-mark.svg" alt="" width="46" height="24"><span>opencrawl</span></a>${nav}</header>${content}</section></body></html>`;
}

