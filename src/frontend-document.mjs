import {escapeHtml as escape} from './frontend-html.mjs';
/** Shared product frame. Runtime adapters supply navigation and sign-out destinations. */
export function renderDocument(content, {
  onboarding = false, title = 'OpenCrawl', signOutUrl = '/auth/logout',
  script = onboarding ? 'onboarding' : 'workspace', styles = [],
} = {}) {
  const navigation = onboarding ? '' : `<nav aria-label="Workspace"><a href="/" aria-current="page">Home</a><a href="/integrations">Sources</a><a href="/usage">Usage</a><a href="/team">Team</a></nav>`;
  const account = signOutUrl ? `<form class="header-account" method="post" action="${escape(signOutUrl)}"><button class="quiet" type="submit">Sign out</button></form>` : '';
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#000"><meta name="robots" content="noindex,nofollow"><title>${escape(title)}</title>
<link rel="icon" href="/assets/opencrawl-mark.svg"><link rel="preload" href="/assets/geist-sans.woff2" as="font" type="font/woff2" crossorigin>
${['tokens','controls','frontend',onboarding?'onboarding':'workspace',...styles].map(style=>`<link rel="stylesheet" href="/${escape(style)}.css">`).join('')}
<script type="module" src="/${escape(script)}.js"></script></head><body${onboarding?' data-onboarding':''}>
<a class="skip-link" href="#main">Skip to content</a><header class="app-header"><a class="brand" href="/" aria-label="OpenCrawl home"><img src="/assets/opencrawl-mark.svg" width="38" height="20" alt=""><span>opencrawl</span></a>${navigation}${account}</header>${content}</body></html>`;
}
