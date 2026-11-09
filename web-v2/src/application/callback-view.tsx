import {LinkButton, PageHeader} from '../design/components.tsx';

interface Continuation {name: string; returnTo: '/sources' | '/onboarding/sources'; actions: Array<{label: string; url: string}>}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export function readContinuation(raw: string): Continuation | null {
  let value: unknown;
  try {value = JSON.parse(raw);} catch {return null;}
  if (!object(value) || typeof value.name !== 'string' ||
    (value.returnTo !== '/sources' && value.returnTo !== '/onboarding/sources') || !Array.isArray(value.actions) || !value.actions.length) return null;
  const actions: Continuation['actions'] = [];
  for (const action of value.actions) {
    if (!object(action) || typeof action.label !== 'string' || typeof action.url !== 'string') return null;
    let url: URL;
    try {url = new URL(action.url);} catch {return null;}
    if (url.origin !== 'https://github.com' || url.username || url.password || url.hash ||
      !(url.pathname === '/login/oauth/authorize' || /^\/apps\/[a-z0-9-]+\/installations\/new$/.test(url.pathname))) return null;
    actions.push({label: action.label, url: url.href});
  }
  return {name: value.name, returnTo: value.returnTo, actions};
}

export function CallbackChoices({model}: {model: Continuation | null}) {
  if (!model) return <div className="stack"><PageHeader title="This link has expired" description="Return to Sources and try connecting again."/><LinkButton to="/sources" reloadDocument>Return to Sources</LinkButton></div>;
  return <div className="stack"><PageHeader title={`Connect ${model.name}`} description="Choose an installed account, or install the App for another account. Only repositories you can access will be imported."/>
    <div className="stack-sm">{model.actions.map(action => <LinkButton key={action.url} to={action.url} reloadDocument>{action.label}</LinkButton>)}</div>
    <div className="actions"><LinkButton to={model.returnTo} reloadDocument variant="quiet">Return to Sources</LinkButton></div>
  </div>;
}
