import type {IncomingMessage} from 'node:http';
import type {JWTVerifyGetKey} from 'jose';
import type {Principal,DirectoryMembership} from './types.mjs';
import type {DevinState} from '../state/devin.mjs';
import {createDevinConnections} from './devin-connections.mjs';
import {createDevinWorkloads,createDevinVerifier} from './devin.mjs';
import {devinAdminHandler,devinConnectionHandler} from './devin-http.mjs';

/** Both deployments bind the same Cloud identity to an administrator-approved
 * workspace. Each deployment supplies its authoritative human identity directory. */
export function devinRuntime({repository,audience,tenantId,key,isAdmin,authenticateAdmin}:{
  repository:DevinState; audience:string; tenantId?:string; key?:JWTVerifyGetKey;
  isAdmin:(principal:Principal)=>Promise<boolean>;
  authenticateAdmin:(req:IncomingMessage)=>Promise<{principal:Principal;member:DirectoryMembership}>;
}){
  const connections=createDevinConnections({repository,tenantId,isAdmin,verify:createDevinVerifier({audience,key})});
  const workloads=createDevinWorkloads({audience,key,tenantId,resolveOrganization:connections.resolveOrganization});
  return {connections,workloads,connect:devinConnectionHandler(connections),approve:devinAdminHandler(connections,authenticateAdmin,'approve'),
    disconnect:devinAdminHandler(connections,authenticateAdmin,'disconnect')};
}
