import type {HostedUser, IdentityDirectory, Principal} from './types.mjs';
import {errorInfo} from './types.mjs';
import {activeMemberships} from './principal.mjs';
import type {RoleWriteGuard, TeamRole} from './role-write.mjs';
import {isAdmin, teamChange, authorizeTeamChange, applyTeamChange, verifyTeamChange, type TeamChange, type TeamChangeRequest} from './team-change.mjs';
export {isAdmin} from './team-change.mjs';

interface AdminMembership {userId: string; organizationId: string; status: string; role?: {slug: string}; roles?: Array<{slug: string}>}
const fail = (status: number, message: string): never => {throw Object.assign(new Error(message), {status, expose: true});};

export function teamService(directory: IdentityDirectory, roleGuard?: RoleWriteGuard, revokeCaptureCredentials?: (principal: Principal) => Promise<void>, durableWrite?: (change:TeamChange)=>Promise<void>) {
  // Callers that already loaded this request's membership pass it to skip a provider round trip.
  const requireAdmin = async (user: HostedUser, organizationId: string, known?: AdminMembership) => {
    const member = known?.userId === user.id && known.organizationId === organizationId && known.status === 'active' ? known
      : (await activeMemberships(directory, user.id, organizationId))[0];
    if (!isAdmin(member)) fail(403, 'Only an organization admin can do that.');
    return member;
  };
  async function write(change:TeamChangeRequest) {
    if (durableWrite) {
      const {actorMembershipId,targetMembershipId}=await authorizeTeamChange(directory,change);
      return durableWrite({...change,actorMembershipId,targetMembershipId});
    }
    if (!roleGuard || (change.role==='remove' && !revokeCaptureCredentials))
      return fail(503,change.role==='remove'?'Member removal is temporarily unavailable.':'Role changes are temporarily unavailable. Please try again later.');
    const guard=await roleGuard(change.organizationId,change.actorId,change.userId,change.role);
    let attempted=false,confirmed=false;
    try {
      const {actorMembershipId,targetMembershipId,needsWrite}=await authorizeTeamChange(directory,change);
      if (needsWrite) {
        attempted=true;
        await applyTeamChange(directory,change,targetMembershipId);
        if (change.role==='remove') await revokeCaptureCredentials!({tenantId:change.organizationId,userId:change.userId});
        await verifyTeamChange(directory,{...change,actorMembershipId,targetMembershipId});
        confirmed=true;
      }
    } catch (error) {
      if (attempted && !confirmed && !errorInfo(error).expose) fail(503,change.role==='remove'?'Member removal could not be verified. Contact your workspace operator before trying again.':'The role change could not be verified. Contact support before trying again.');
      throw error;
    } finally {
      if (!attempted || confirmed) await guard.release();
    }
  }
  return {
    async rename(user: HostedUser, organizationId: string, inputName: unknown): Promise<{ok:true; name:string}> {
      const name = typeof inputName === 'string' ? inputName.trim() : '';
      if (!name || name.length > 100) fail(400, 'Enter an organization name between 1 and 100 characters.');
      const authorize = async () => {
        const current = await activeMemberships(directory,user.id,organizationId);
        if (current.length !== 1 || !isAdmin(current[0])) fail(403, 'Only a current organization admin can rename the organization.');
      };
      await authorize();
      // Only the display name is written. Metadata, domains, admission policy and
      // membership remain owned by their existing operations.
      const updated = await directory.organizations.updateOrganization({organization:organizationId,name});
      await authorize();
      if (updated.id !== organizationId || updated.name !== name) fail(503, 'The organization name could not be confirmed. Please try again.');
      return {ok:true,name:updated.name};
    },
    requireAdmin,
    async removeMember(user:HostedUser,organizationId:string,inputUserId:unknown):Promise<{ok:true;userId:string}> {
      const change=teamChange(organizationId,user.id,inputUserId,'remove');
      await write(change);
      return {ok:true,userId:change.userId};
    },
    async changeRole(user:HostedUser,organizationId:string,inputUserId:unknown,inputRole:unknown):Promise<{ok:true;userId:string;role:TeamRole}> {
      if (inputRole!=='admin' && inputRole!=='member') return fail(400,'Choose Admin or Member.');
      const change=teamChange(organizationId,user.id,inputUserId,inputRole);
      await write(change);
      return {ok:true,userId:change.userId,role:inputRole};
    },
    async pendingInvitations(user: HostedUser, organizationId: string, membership?: AdminMembership) {
      await requireAdmin(user, organizationId, membership);
      const result = await directory.userManagement.listInvitations({organizationId, limit:100});
      return result.data.filter(invite => invite.state === 'pending' && invite.organizationId === organizationId)
        .map(invite => ({email:invite.email,...(invite.acceptInvitationUrl?{inviteUrl:invite.acceptInvitationUrl}:{})}));
    },
    async invite(user: HostedUser, organizationId: string, inputEmail: unknown, membership?: AdminMembership) {
      await requireAdmin(user, organizationId, membership);
      const email = typeof inputEmail === 'string' ? inputEmail.trim().toLowerCase() : '';
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid teammate email address.');
      if (email === user.email.toLowerCase()) fail(400, 'You’re already a member. Enter a teammate’s email address.');
      try {return await directory.userManagement.sendInvitation({organizationId, email, inviterUserId: user.id, roleSlug: 'member'});}
      catch (error) {
        if ([400, 409, 422].includes(errorInfo(error).status ?? 0)) fail(409, 'That teammate may already be a member or have a pending invitation. Check their access before trying again.');
        throw error;
      }
    },
  };
}
