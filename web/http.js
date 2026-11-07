/** Same-origin browser transport; identity and scope always come from the server. */
export async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store', ...options,
    headers: {'content-type': 'application/json', ...options.headers},
    signal: options.signal || AbortSignal.timeout(30000),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) location.assign('/auth/login');
  if (response.status === 402) location.assign('/billing');
  if (data.onboardingUrl && /^\/onboarding(?:\/|$)/.test(data.onboardingUrl)) location.assign(data.onboardingUrl);
  if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : data.error?.message || 'We couldn’t complete that request. Try again.'), {status: response.status});
  return data;
}
