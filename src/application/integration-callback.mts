import type {CallbackPage} from './page-types.mjs';
/** Provider handoffs carry data; the shared React application renders every state. */
export function callbackPage({ok,reason,name,returnTo='/sources',actions}: {ok:boolean;reason?:string;name:string;returnTo?:string;actions?:Array<{label:string;url:string}>}): CallbackPage {
  return {kind:'integration-callback',ok,reason,name,returnTo:returnTo === '/onboarding/sources' ? returnTo : '/sources',...(actions?.length ? {actions} : {})};
}
