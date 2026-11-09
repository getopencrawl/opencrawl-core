import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router';
import {CallbackChoices, readContinuation} from './callback-view.tsx';
import '../styles.css';

const page = document.querySelector<HTMLElement>('[data-page="integration-callback"]');
if (page?.dataset.continuation) {
  createRoot(page).render(createElement(BrowserRouter, null, createElement(CallbackChoices, {model: readContinuation(page.dataset.continuation)})));
} else if (page) {
  const ok = page.dataset.ok === 'true';
  if (window.opener) {
    window.opener.postMessage({type:'opencrawl:integrations',ok}, window.location.origin);
    if (ok) window.close();
  }
}
