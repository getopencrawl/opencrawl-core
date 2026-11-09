const escape = (value: string) => value.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character] || character));
/** Provider redirects are document handoffs; application navigation remains in React. */
export function renderCallback({ok, reason, name, returnTo = '/sources', actions}: {ok: boolean; reason?: string; name: string; returnTo?: string; actions?: Array<{label: string; url: string}>}) {
  const target = ['/sources','/onboarding/sources'].includes(returnTo) ? returnTo : '/sources';
  if (actions?.length) {
    const model = JSON.stringify({name, returnTo: target, actions});
    return `<link rel="stylesheet" href="/console/assets/callback.css"><main data-page="integration-callback" data-continuation="${escape(model)}"></main><script src="/console/assets/callback.js" type="module"></script>`;
  }
  const inOnboarding = returnTo === '/onboarding/sources';
  const heading = reason === 'repositories' ? 'No accessible repositories' : ok ? `${name} is connected` : reason === 'declined' ? `${name} wasn’t connected` : inOnboarding ? 'Try connecting again' : reason === 'taken' ? `Your team already connected ${name}` : 'This link has expired';
  const detail = reason === 'repositories' ? 'Ask your GitHub administrator to grant this App and your account access to the repositories, then connect again.' : inOnboarding ? (ok ? 'Your import has started. Return to your sources to continue setup.' : 'Your other connections are saved. Return to your sources and try again.') : ok ? 'Your import has started. You can close this window.' : reason === 'taken' ? 'A teammate connected it first, so there’s nothing more to do.' : 'Return to Sources and try connecting again.';
  return `<main data-page="integration-callback" data-ok="${ok}" data-return-to="${target}"><h1>${escape(heading)}</h1><p>${detail}</p><a class="button-link primary" href="${target}">Continue</a></main><script src="/console/assets/callback.js" type="module"></script>`;
}
