import {WorkOS} from '@workos-inc/node';
import type {IdentityDirectory,DirectoryMembership,HostedUser} from './types.mjs';
/** Initialize only the operator-selected WorkOS client; no hosted client defaults. */
export function createWorkos({apiKey,clientId}:{apiKey:string;clientId:string}){return new WorkOS(apiKey,{clientId,issuer:`https://api.workos.com/user_management/${clientId}`});}

/** Preserve WorkOS authentication and pagination; expose only core account facts. */
export function workosDirectory(workos:WorkOS):IdentityDirectory {
  const member=(m:DirectoryMembership):DirectoryMembership=>({id:m.id,userId:m.userId,organizationId:m.organizationId,status:m.status,
    role:m.role?{slug:m.role.slug}:undefined,roles:m.roles?.map(r=>({slug:r.slug})),directoryManaged:m.directoryManaged});
  const user=(u:HostedUser):HostedUser=>({id:u.id,email:u.email,firstName:u.firstName,lastName:u.lastName,emailVerified:u.emailVerified===true});
  return {
    userManagement:{
      async getUser(id){return user(await workos.userManagement.getUser(id));},
      async listOrganizationMemberships(options){const rows=await workos.userManagement.listOrganizationMemberships(options.userId?{...options,userId:options.userId}:options.organizationId?{...options,organizationId:options.organizationId}:(()=>{throw new Error('A user or organization scope is required');})());return {data:rows.data.map(member),autoPagination:rows.autoPagination?async()=>(await rows.autoPagination()).map(member):undefined};},
      async listSessions(id,options){const rows=await workos.userManagement.listSessions(id,options);return {data:rows.data.map(s=>({id:s.id,userId:s.userId,status:s.status,endedAt:s.endedAt,expiresAt:s.expiresAt})),listMetadata:{after:rows.listMetadata.after}};},
      async updateOrganizationMembership(id,options){return member(await workos.userManagement.updateOrganizationMembership(id,options));},
      async deleteOrganizationMembership(id){await workos.userManagement.deleteOrganizationMembership(id);},
      async listInvitations(options){const rows=await workos.userManagement.listInvitations(options);return {data:rows.data.map(i=>({email:i.email,state:i.state,organizationId:i.organizationId}))};},
      async sendInvitation(options){const i=await workos.userManagement.sendInvitation(options);return {id:i.id,email:i.email};},
    },
    organizations:{
      async getOrganization(id){const o=await workos.organizations.getOrganization(id);return {id:o.id,name:o.name};},
      async updateOrganization(options){const o=await workos.organizations.updateOrganization(options);return {id:o.id,name:o.name};},
    },
  };
}
