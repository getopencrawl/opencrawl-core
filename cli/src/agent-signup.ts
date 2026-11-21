import { readFile } from 'node:fs/promises';
import { atomicJson, readSession, sessionFile, withSessionLock, type Session } from './session.ts';
import { apiOrigin, CliError, jsonRequest, refresh } from './oauth.ts';

type Registration = {
  pendingExchange?: boolean;
  id: string;
  identity: { assertion: string; refresh_token?: string };
  claim?: { token: string };
};
type Discovery = { issuer: string; clientId: string; tokenEndpoint: string; bootstrapEndpoint: string };
const failure = (code: string, message: string) => new CliError(code, message, 2);
async function discovery(api: string, fetcher: typeof fetch): Promise<Discovery> {
  const { body, response } = await jsonRequest(api + '/.well-known/opencrawl-cli', {}, fetcher),
    r = body.agentRegistration;
  if (
    !response.ok ||
    body.schemaVersion !== 1 ||
    !r ||
    typeof r.issuer !== 'string' ||
    !body.auth?.clientId ||
    r.tokenEndpoint !== api + '/api/agent/token' ||
    r.bootstrapEndpoint !== api + '/api/agent/bootstrap'
  )
    throw failure('SIGNUP_UNAVAILABLE', 'This deployment does not advertise agent signup.');
  return {
    issuer: apiOrigin(r.issuer),
    clientId: body.auth.clientId,
    tokenEndpoint: r.tokenEndpoint,
    bootstrapEndpoint: r.bootstrapEndpoint,
  };
}
async function post(url: string, input: object, fetcher: typeof fetch) {
  const { response, body } = await jsonRequest(
    url,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) },
    fetcher,
  );
  if (!response.ok)
    throw failure(
      'REGISTRATION_REJECTED',
      'The identity provider could not complete this registration step (HTTP ' +
        response.status +
        '). Reuse the saved registration when retrying.',
    );
  return body;
}
function check(value: Registration, previous?: string) {
  if (
    !/^agent_reg_[A-Za-z0-9]+$/.test(value?.id) ||
    !value.identity?.assertion ||
    (previous && value.id !== previous)
  )
    throw failure('INVALID_RESPONSE', 'Unexpected agent identity returned.');
  return value;
}
export async function agentSignup(
  api: string,
  action: string | undefined,
  email: string | undefined,
  fetcher = fetch,
) {
  if (process.env.OPENCRAWL_TOKEN || process.env.OPENCRAWL_SESSIONS_TOKEN || process.env.OPENCRAWL_AUTH)
    throw failure('SIGNUP_CONFLICT', 'This machine is already configured to use an external identity.');
  if ((action && !['claim', 'complete'].includes(action)) || (email && action !== 'claim'))
    throw failure(
      'INVALID_USAGE',
      'Use signup, signup claim --email ADDRESS, or signup complete with the confirmation code on stdin.',
    );
  const d = await discovery(api, fetcher);
  return withSessionLock(api, async () => {
    const saved = readSession(api);
    if (saved && !saved.registrationId)
      throw failure(
        'SIGNUP_CONFLICT',
        'This profile is already signed in. Use its workspace or choose a new profile.',
      );
    const file = sessionFile(api) + '.registration';
    let reg: Registration;
    try {
      reg = check(JSON.parse(await readFile(file, 'utf8')), saved?.registrationId);
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      if (saved || action)
        throw failure('REGISTRATION_REQUIRED', 'This profile has no saved registration for this operation.');
      reg = check(await post(d.issuer + '/agent/identity', { type: 'anonymous' }, fetcher));
      atomicJson(file, reg);
    }
    if (action === 'claim') {
      if (!email || email.length > 254 || !reg.claim?.token)
        throw failure('INVALID_USAGE', 'Supply the email of the person claiming this workspace.');
      const attempt = await post(
        d.issuer + '/agent/identity/claim',
        { type: 'service_auth', login_hint: email, claim_token: reg.claim.token },
        fetcher,
      );
      const url = new URL(attempt.attempt?.verification_uri);
      if (url.origin !== d.issuer) throw failure('INVALID_RESPONSE', 'Unexpected verification origin.');
      return { verificationUrl: url.href };
    }
    if (action === 'complete') {
      if (process.stdin.isTTY || !reg.claim?.token)
        throw failure('INVALID_USAGE', 'Pipe the WorkOS confirmation code on stdin.');
      let input = '';
      for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 128) throw failure('INVALID_USAGE', 'Invalid confirmation code.');
      }
      if (!/^[A-Za-z0-9-]{4,32}$/.test(input.trim())) throw failure('INVALID_USAGE', 'Invalid confirmation code.');
      reg = check(
        await post(
          d.issuer + '/agent/identity/claim/complete',
          { claim_token: reg.claim.token, user_code: input.trim() },
          fetcher,
        ),
        reg.id,
      );
      reg.pendingExchange = true;
      atomicJson(file, reg);
    }
    const auth = {
      clientId: d.clientId,
      tokenEndpoint: d.tokenEndpoint,
      deviceAuthorizationEndpoint: d.issuer + '/agent/identity',
    };
    const initial = Buffer.from(
      JSON.stringify({ assertion: reg.identity.assertion, refresh: reg.identity.refresh_token }),
    ).toString('base64url');
    const token = await refresh(auth, reg.pendingExchange ? initial : (saved?.refreshToken ?? initial), fetcher);
    const session: Session = { auth, ...token, registrationId: reg.id };
    atomicJson(sessionFile(api), session);
    if (reg.pendingExchange) {
      delete reg.pendingExchange;
      atomicJson(file, reg);
    }
    const { response, body } = await jsonRequest(
      d.bootstrapEndpoint,
      { method: 'POST', headers: { authorization: 'Bearer ' + token.accessToken } },
      fetcher,
    );
    if (
      !response.ok ||
      body.data?.registrationId !== reg.id ||
      !/^org_[a-zA-Z0-9]+$/.test(body.data?.workspace?.id ?? '')
    )
      throw failure(
        'BOOTSTRAP_FAILED',
        'Workspace activation did not complete (HTTP ' + response.status + '). Retry signup with this profile.',
      );
    return { workspace: body.data.workspace, claimed: body.data.claimed, limits: body.data.limits };
  });
}
