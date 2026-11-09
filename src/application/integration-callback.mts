const escape = (value: string) => value.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character] || character));
/** Provider redirects are document handoffs; application navigation remains in React. */
export function renderCallback({ok, reason, name, returnTo = '/sources'}: {ok: boolean; reason?: string; name: string; returnTo?: string}) {
  const inOnboarding = returnTo === '/onboarding/sources';
  const heading = ok ? `${name} is connected` : reason === 'declined' ? `${name} wasn’t connected` : inOnboarding ? 'Try connecting again' : reason === 'taken' ? `Your team already connected ${name}` : 'This link has expired';
  const detail = inOnboarding ? (ok ? 'Your import has started. Return to your sources to continue setup.' : 'Your other connections are saved. Return to your sources and try again.') : ok ? 'Your import has started. You can close this window.' : reason === 'taken' ? 'A teammate connected it first, so there’s nothing more to do.' : 'Return to Sources and try connecting again.';
  const target = ['/sources','/onboarding/sources'].includes(returnTo) ? returnTo : '/sources';
  return `<main data-page="integration-callback" data-ok="${ok}" data-return-to="${target}"><h1>${escape(heading)}</h1><p>${detail}</p><a class="button-link primary" href="${target}">Continue</a></main><script src="/console/assets/callback.js" type="module"></script>`;
}
