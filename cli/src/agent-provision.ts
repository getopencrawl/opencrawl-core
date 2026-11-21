import {CliError} from './oauth.ts';
import {readSession,type Session} from './session.ts';
import {agentSignup} from './agent-signup.ts';
import {setupCommand} from './setup/command.ts';

type ProvisionDependencies = {
  session?: (api:string)=>Pick<Session,'registrationId'>|null;
  signup?: (...args:Parameters<typeof agentSignup>)=>Promise<unknown>;
  setup?: (...args:Parameters<typeof setupCommand>)=>Promise<unknown>;
  env?: NodeJS.ProcessEnv;
};

/** Explicit machine enrollment. The setup engine owns client detection, binding,
 * future-only boundaries, native permissions, and installation verification. */
export async function provisionAgentHost(api:string,captureNew:boolean,{
  session=readSession,signup=agentSignup,setup=setupCommand,env=process.env,
}:ProvisionDependencies={}){
  if(!captureNew)throw new CliError('INVALID_USAGE','Use provision --capture-new to connect supported agents and record their future sessions in this workspace.',64);
  const saved=session(api);
  const external=Boolean(env.OPENCRAWL_AUTH||env.OPENCRAWL_TOKEN||env.OPENCRAWL_SESSIONS_TOKEN);
  // A saved registration can still need bootstrap after an interrupted signup.
  // An existing human or provider identity must be verified by setup in place.
  if(!external&&(!saved||saved.registrationId))await signup(api,undefined,undefined);
  return setup('apply',api,{plugins:'all',forward:'all',history:'none','capture-mode':'hook',yes:true,json:true},{interactive:false});
}
