import type {AuthPage} from '../../../src/application/page-types.mjs';
import {Button,Field,Input,LinkButton,Notice,Page} from '../design/components.tsx';

/** Browser-owned forms; the server supplies data and enforces every decision. */
export function AuthDocument({page}: {page:AuthPage}) {
  const login=page.view==='login',setup=page.view==='setup',join=page.view==='join',consent=page.view==='consent',device=page.view==='device';
  const title=login?'Sign in to OpenCrawl':setup?'Set up OpenCrawl':join?'Join your team on OpenCrawl':consent?`Allow ${page.clientName || 'this app'} to use OpenCrawl?`:'Connect the OpenCrawl CLI';
  const description=login?'Use your account on this installation.':setup?'Create the first admin account for this workspace.':join?`Create the account for ${page.email}.`:consent?'This app will be able to search your workspace and use the agent board as you.':'Confirm this code matches the one in your terminal. Only connect a login you started.';
  const action=login?'/auth/login':setup||join?'/auth/signup':consent?'/auth/consent':'/device';
  return <Page title={title} description={description}>
    {page.error && <Notice tone="danger">{page.error}</Notice>}
    {consent && <dl><dt>Resource</dt><dd>{page.resource}</dd><dt>Requested scopes</dt><dd>{page.scopes?.join(', ')}</dd></dl>}
    <form method="post" action={action} className="stack oc-form-measure">
      {setup && <Field label="Workspace name"><Input name="workspace" required maxLength={100}/></Field>}
      {(setup||join) && <Field label="Your name"><Input name="name" required maxLength={100} autoComplete="name"/></Field>}
      {(setup||login) && <Field label="Email"><Input name="email" type="email" required autoComplete="username"/></Field>}
      {(setup||join||login) && <Field label={login?'Password':'Password (10+ characters)'}><Input name="password" type="password" required minLength={login?undefined:10} autoComplete={login?'current-password':'new-password'}/></Field>}
      {device && <Field label="Code"><Input name="user_code" required defaultValue={page.code} autoComplete="off"/></Field>}
      {page.setup && <Input type="hidden" name="setup" value={page.setup}/>}
      {page.invitation && <Input type="hidden" name="invitation" value={page.invitation}/>}
      {page.next && <Input type="hidden" name="next" value={page.next}/>}
      {page.oauthQuery && <Input type="hidden" name="oauth_query" value={page.oauthQuery}/>}
      <div className="actions">
        <Button type="submit" variant="primary" name={consent?'accept':device?'decision':undefined} value={consent?'true':device?'approve':undefined}>{login?'Sign in':setup?'Create workspace':join?'Create account':consent?'Allow':'Connect'}</Button>
        {(consent||device) && <Button type="submit" name={consent?'accept':'decision'} value={consent?'false':'deny'}>{consent?'Deny':'Cancel'}</Button>}
      </div>
    </form>
    {login && <p>New here? Ask an admin for an invitation link.</p>}
    {join && <LinkButton to={'/auth/login?invitation='+encodeURIComponent(page.invitation || '')} reloadDocument>Sign in to an existing account</LinkButton>}
  </Page>;
}
