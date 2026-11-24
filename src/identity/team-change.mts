import type {DirectoryMembership, IdentityDirectory} from './types.mjs';
import type {TeamRole} from './role-write.mjs';
import {activeMemberships} from './principal.mjs';

export interface TeamChangeRequest {organizationId:string; actorId:string; userId:string; role:TeamRole|'remove'}
export interface TeamChange extends TeamChangeRequest {actorMembershipId:string; targetMembershipId:string}
export type ChangeFailure = {ok:false; status:number; message:string};
export type ChangeOutcome = {ok:true} | ChangeFailure;

export const isAdmin = (member:Pick<DirectoryMembership,'role'|'roles'>|null|undefined) =>
  [member?.role,...(member?.roles || [])].some(role => role?.slug === 'admin');
export const rejectChange = (status:number,message:string):never => {throw Object.assign(new Error(message),{status,expose:true});};

export function teamChange(organizationId:string, actorId:string, inputUserId:unknown, inputRole:unknown):TeamChangeRequest {
  if (!/^org_[A-Za-z0-9]+$/.test(organizationId)) rejectChange(400,'Choose a valid workspace.');
  if (typeof inputUserId !== 'string' || !/^user_[A-Za-z0-9]+$/.test(inputUserId)) return rejectChange(400,'Choose an active teammate.');
  if (inputRole !== 'remove' && inputRole !== 'admin' && inputRole !== 'member') return rejectChange(400,'Choose Admin or Member.');
  if (inputUserId === actorId) rejectChange(400,inputRole==='remove'?'You cannot remove yourself. Ask another admin to remove you.':'You cannot change your own role.');
  return {organizationId,actorId,userId:inputUserId,role:inputRole};
}

function matches(member:DirectoryMembership|undefined, change:TeamChangeRequest, membershipId:string) {
  return member?.id === membershipId && member.userId === change.userId && member.organizationId === change.organizationId &&
    member.status === 'active' && member.role?.slug === change.role && (member.roles || []).every(role => role.slug === change.role);
}

async function readMemberships(directory:IdentityDirectory, change:TeamChangeRequest) {
  const {organizationId,actorId,userId}=change;
  return Promise.all([activeMemberships(directory,actorId,organizationId),activeMemberships(directory,userId,organizationId)]);
}

/** Intake binds the directory membership instances. A worker repeats both reads under the guard. */
export async function authorizeTeamChange(directory:IdentityDirectory,change:TeamChangeRequest) {
  const [actors,targets]=await readMemberships(directory,change);
  const actor=actors.length===1?actors[0]:undefined;
  if (!actor?.id || !isAdmin(actor)) return rejectChange(403,change.role==='remove'?'Only a current organization admin can remove members.':'Only a current organization admin can change roles.');
  const target=targets.length===1?targets[0]:undefined;
  if (!target?.id) return rejectChange(404,'That teammate is no longer an active workspace member.');
  if (target.directoryManaged) rejectChange(409,change.role==='remove'?'Remove this teammate through your identity provider. Their membership is directory-managed.':'This teammate’s role is managed by your identity provider.');
  return {actorMembershipId:actor.id,targetMembershipId:target.id,needsWrite:!matches(target,change,target.id)};
}

export async function applyTeamChange(directory:IdentityDirectory,change:TeamChangeRequest,membershipId:string) {
  if (change.role==='remove') return directory.userManagement.deleteOrganizationMembership(membershipId);
  const updated=await directory.userManagement.updateOrganizationMembership(membershipId,{roleSlug:change.role});
  if (!matches(updated,change,membershipId)) rejectChange(503,'The role change could not be verified. Contact support before trying again.');
}

export async function verifyTeamChange(directory:IdentityDirectory,change:TeamChange) {
  const [actors,targets]=await readMemberships(directory,change);
  const sameAdmin=actors.length===1 && actors[0]?.id===change.actorMembershipId && isAdmin(actors[0]);
  if (change.role==='remove') {
    if (targets.length || !sameAdmin) rejectChange(503,'Member removal could not be verified. Contact your workspace operator before trying again.');
  } else {
    if (!sameAdmin) rejectChange(403,'Your administrator access changed while updating the role. Contact support before trying again.');
    if (targets.length!==1 || !matches(targets[0],change,change.targetMembershipId)) rejectChange(503,'Workspace access changed while updating the role. Contact support before trying again.');
  }
}
