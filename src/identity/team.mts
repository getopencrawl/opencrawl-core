import type {HostedUser, IdentityDirectory, Principal} from './types.mjs';
import {errorInfo} from './types.mjs';
import {activeMemberships} from './principal.mjs';
import type {RoleWriteGuard, TeamRole} from './role-write.mjs';

interface AdminMembership {userId: string; organizationId: string; status: string; role?: {slug: string}; roles?: Array<{slug: string}>}
const fail = (status: number, message: string): never => {throw Object.assign(new Error(message), {status, expose: true});};
export const isAdmin = (membership: Pick<AdminMembership, 'role' | 'roles'> | null | undefined) => [membership?.role, ...(membership?.roles || [])].some(role => role?.slug === 'admin');

export function teamService(directory: IdentityDirectory, roleGuard?: RoleWriteGuard, revokeCaptureCredentials?: (principal: Principal) => Promise<void>) {
  // Callers that already loaded this request's membership pass it to skip a provider round trip.
  const requireAdmin = async (user: HostedUser, organizationId: string, known?: AdminMembership) => {
    const member = known?.userId === user.id && known.organizationId === organizationId && known.status === 'active' ? known
      : (await activeMemberships(directory, user.id, organizationId))[0];
    if (!isAdmin(member)) fail(403, 'Only an organization admin can do that.');
    return member;
  };
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
    async removeMember(user: HostedUser, organizationId: string, inputUserId: unknown): Promise<{ok:true;userId:string}> {
      if(typeof inputUserId!=='string'||!/^user_[A-Za-z0-9]+$/.test(inputUserId))fail(400,'Choose an active teammate.');
      const userId=inputUserId as string;
      // Keeping the acting admin, under the same guard as role changes, prevents
      // two admins removing/demoting one another and leaving no administrator.
      if(userId===user.id)fail(400,'You cannot remove yourself. Ask another admin to remove you.');
      if(!roleGuard||!revokeCaptureCredentials)fail(503,'Member removal is temporarily unavailable.');
      const guard=await roleGuard!(organizationId,user.id,userId,'remove');
      let attempted=false,confirmed=false;
      try{
        const [actors,targets]=await Promise.all([activeMemberships(directory,user.id,organizationId),activeMemberships(directory,userId,organizationId)]);
        if(actors.length!==1||!isAdmin(actors[0]))fail(403,'Only a current organization admin can remove members.');
        const target=targets.length===1?targets[0]:undefined;
        if(!target?.id)fail(404,'That teammate is no longer an active workspace member.');
        if(target!.directoryManaged)fail(409,'Remove this teammate through your identity provider. Their membership is directory-managed.');
        attempted=true;
        await directory.userManagement.deleteOrganizationMembership(target!.id);
        await revokeCaptureCredentials!({tenantId:organizationId,userId});
        const [currentActors,currentTargets]=await Promise.all([activeMemberships(directory,user.id,organizationId),activeMemberships(directory,userId,organizationId)]);
        if(currentTargets.length||currentActors.length!==1||!isAdmin(currentActors[0]))fail(503,'Member removal could not be verified. Contact your workspace operator before trying again.');
        confirmed=true;
        return {ok:true,userId};
      }catch(error){
        if(attempted&&!confirmed&&!errorInfo(error).expose)fail(503,'Member removal could not be verified. Contact your workspace operator before trying again.');
        throw error;
      }finally{
        // An ambiguous provider deletion can still complete later. Keep the
        // organization guard held until its outcome is reconciled by the operator.
        if(!attempted||confirmed)await guard.release();
      }
    },
    async changeRole(user: HostedUser, organizationId: string, inputUserId: unknown, inputRole: unknown): Promise<{ok:true; userId:string; role:TeamRole}> {
      if (typeof inputUserId !== 'string' || !/^user_[A-Za-z0-9]+$/.test(inputUserId)) fail(400, 'Choose an active teammate.');
      if (inputRole !== 'admin' && inputRole !== 'member') fail(400, 'Choose Admin or Member.');
      const userId = inputUserId as string, role = inputRole as TeamRole;
      if (userId === user.id) fail(400, 'You cannot change your own role.');
      if (!roleGuard) fail(503, 'Role changes are temporarily unavailable. Please try again later.');
      const guard = await roleGuard!(organizationId, user.id, userId, role);
      let attempted = false, confirmed = false;
      try {
        // Both identities are re-read inside the cross-replica guard. Session roles
        // and the page's roster are never authority for this write.
        const [actors, targets] = await Promise.all([activeMemberships(directory,user.id,organizationId),activeMemberships(directory,userId,organizationId)]);
        if (actors.length !== 1 || !isAdmin(actors[0])) fail(403, 'Only a current organization admin can change roles.');
        const target = targets.length === 1 ? targets[0] : undefined;
        if (!target?.id) fail(404, 'That teammate is no longer an active workspace member.');
        if (target!.directoryManaged) fail(409, 'This teammate’s role is managed by your identity provider.');
        const matches = (membership: typeof target) => Boolean(membership && membership.id === target!.id && membership.userId === userId && membership.organizationId === organizationId && membership.status === 'active' && membership.role?.slug === role && (membership.roles || []).every(item => item.slug === role));
        if (!matches(target)) {
          attempted = true;
          const updated = await directory.userManagement.updateOrganizationMembership(target!.id, {roleSlug:role});
          if (!matches(updated)) fail(503, 'The role change could not be verified. Contact support before trying again.');
          const [currentActors, currentTargets] = await Promise.all([activeMemberships(directory,user.id,organizationId),activeMemberships(directory,userId,organizationId)]);
          if (currentActors.length !== 1 || !isAdmin(currentActors[0]))
            fail(403, 'Your administrator access changed while updating the role. Contact support before trying again.');
          if (currentTargets.length !== 1 || !matches(currentTargets[0]))
            fail(503, 'Workspace access changed while updating the role. Contact support before trying again.');
          confirmed = true;
        }
        return {ok:true,userId,role};
      } catch (error) {
        if (attempted && !confirmed && !errorInfo(error).expose)
          fail(503, 'The role change could not be verified. Contact support before trying again.');
        throw error;
      } finally {
        // Failed validation made no provider write. Once dispatched, only a
        // confirmed result may unlock; a timeout can still complete at WorkOS.
        if (!attempted || confirmed) await guard.release();
      }
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
