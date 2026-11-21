import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSignup } from '../src/agent-signup.ts';
import { readSession, sessionFile } from '../src/session.ts';
import { newSetupClientAvailable } from '../src/setup/availability.ts';
import { registrationMcp, isRegistrationMcp } from '../src/setup/registration-mcp.ts';

test('unattended signup persists a retryable registration before bootstrap and keeps credentials out of output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-signup-')),
    old = process.env.OPENCRAWL_CONFIG_HOME;
  process.env.OPENCRAWL_CONFIG_HOME = dir;
  const api = 'https://app.example',
    issuer = 'https://issuer.example',
    id = 'agent_reg_123';
  let registrations = 0,
    attempts = 0;
  const mock = async (url: RequestInfo | URL, init?: RequestInit) => {
    switch (String(url)) {
      case api + '/.well-known/opencrawl-cli':
        return Response.json({
          schemaVersion: 1,
          auth: { clientId: 'client' },
          agentRegistration: {
            issuer,
            tokenEndpoint: api + '/api/agent/token',
            bootstrapEndpoint: api + '/api/agent/bootstrap',
          },
        });
      case issuer + '/agent/identity':
        registrations++;
        return Response.json({
          id,
          identity: { assertion: 'secret-assertion' },
          claim: { token: 'secret-claim' },
        });
      case api + '/api/agent/token':
        return Response.json({ access_token: 'short-secret', refresh_token: 'renew-secret', expires_in: 300 });
      case api + '/api/agent/bootstrap':
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer short-secret');
        return ++attempts === 1
          ? Response.json({}, { status: 503 })
          : Response.json({
              data: {
                registrationId: id,
                workspace: { id: 'org_trial' },
                limits: { requests: 2000 },
                claimed: false,
              },
            });
      default:
        throw Error('Unexpected request');
    }
  };
  try {
    await expect(agentSignup(api, undefined, undefined, mock as typeof fetch)).rejects.toMatchObject({
      code: 'BOOTSTRAP_FAILED',
    });
    const result = await agentSignup(api, undefined, undefined, mock as typeof fetch);
    expect(result.workspace.id).toBe('org_trial');
    expect(registrations).toBe(1);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(readSession(api)?.registrationId).toBe(id);
    if (process.platform !== 'win32') expect(statSync(sessionFile(api)).mode & 0o777).toBe(0o600);
  } finally {
    if (old === undefined) delete process.env.OPENCRAWL_CONFIG_HOME;
    else process.env.OPENCRAWL_CONFIG_HOME = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
test('registered machines can install published Linux plugins with an MCP transport bound to the same installation', () => {
  expect(newSetupClientAvailable('claude-code', 'linux', true)).toBe(true);
  expect(newSetupClientAvailable('claude-code', 'linux', false)).toBe(true);
  const api = 'https://app.example',
    dir = tmpdir(),
    config = registrationMcp([join(dir, 'oc')], {
      api,
      configHome: dir,
      installationId: 'install',
      registrationId: 'agent_reg_1',
    });
  expect(isRegistrationMcp(config, api, dir)).toBe(true);
  expect(isRegistrationMcp(config, 'https://another.example', dir)).toBe(false);
});

test('machine provisioning requires future-capture consent and retains the existing credential and history boundary',async()=>{
  const {provisionAgentHost}=await import('../src/agent-provision.ts');
  let signupCount=0;
  const signup=async()=>{signupCount++;return {workspace:{id:'org_trial'},claimed:false,limits:{}};};
  const setup=async(action:string,api:string,values:unknown,deps:unknown)=>({action,api,values,deps});
  const api='https://app.example';
  const deps={session:()=>null,signup,setup,env:{}};
  await expect(provisionAgentHost(api,false,deps)).rejects.toMatchObject({code:'INVALID_USAGE'});
  expect(signupCount).toBe(0);
  expect(await provisionAgentHost(api,true,deps)).toEqual({action:'apply',api,values:{plugins:'all',forward:'all',history:'none','capture-mode':'hook',yes:true,json:true},deps:{interactive:false}});
  await provisionAgentHost(api,true,{...deps,session:()=>({})});
  await provisionAgentHost(api,true,{...deps,env:{OPENCRAWL_TOKEN:'external'}});
  expect(signupCount).toBe(1);
});
