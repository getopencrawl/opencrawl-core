import type {IncomingMessage} from 'node:http';
import {z} from 'zod';
import {isAdmin} from '../identity/team.mjs';
import type {Principal,DirectoryMembership} from '../identity/types.mjs';
import type {ReplicasImport} from '../integrations/replicas-import.mjs';
import {smallJson} from './http.mjs';
import {errorInfo} from '../errors.mjs';
const input=z.object({action:z.literal('connect'),apiKey:z.string().min(1).max(4000)}).strict();
export async function replicasImportRequest(req:IncomingMessage,{imports,principal,member}:{imports?:ReplicasImport;principal:Principal;member:DirectoryMembership}){
  const failure=(status:number,message:string)=>({status,body:{error:{code:'REPLICAS_IMPORT_FAILED',message}}});
  if(member.status!=='active'||member.userId!==principal.userId||member.organizationId!==principal.tenantId||!isAdmin(member))return failure(403,'Only a workspace admin can import Replicas history.');
  if(!imports)return failure(503,'Replicas historical import is not configured on this server.');
  try{
    const parsed=input.safeParse(await smallJson(req,8192));
    if(!parsed.success)return failure(400,'Choose a valid Replicas import action.');
    return {status:200,body:await imports.action(principal,parsed.data)};
  }catch(error){const info=errorInfo(error);return info.expose?failure(info.status===429?429:info.status===409?409:400,info.message):failure(503,'Could not connect to Replicas. Try again shortly.');}
}
