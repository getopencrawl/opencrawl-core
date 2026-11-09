const page = document.querySelector<HTMLElement>('[data-page="integration-callback"]');
if (page) {
  const ok = page.dataset.ok === 'true';
  if (window.opener) {
    window.opener.postMessage({type:'opencrawl:integrations',ok}, window.location.origin);
    if (ok) window.close();
  }
}
