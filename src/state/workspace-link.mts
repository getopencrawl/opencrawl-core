import {createHash} from 'node:crypto';

/** A routing hint lets a host compare a link to the viewer's known memberships without inspecting another tenant's data. */
export function workspaceLinkHint(tenantId:string) {
  return createHash('sha256').update('opencrawl.workspace-link.v1\0'+tenantId).digest().subarray(0,9).toString('base64url');
}
