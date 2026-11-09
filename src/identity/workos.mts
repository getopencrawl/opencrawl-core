import {WorkOS} from '@workos-inc/node';
/** Initialize only the operator-selected WorkOS client; no hosted client defaults. */
export function createWorkos({apiKey,clientId}:{apiKey:string;clientId:string}){return new WorkOS(apiKey,{clientId,issuer:`https://api.workos.com/user_management/${clientId}`});}
