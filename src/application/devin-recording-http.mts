import type {IncomingMessage} from 'node:http';
import {z} from 'zod';
import {isAdmin} from '../identity/team.mjs';
import type {Principal,DirectoryMembership} from '../identity/types.mjs';
import type {DevinRecording} from '../integrations/devin-recording.mjs';
import {DevinReadError} from '../integrations/devin-api.mjs';
import {DevinRateLimitError} from '../integrations/devin-events-client.mjs';
import {smallJson} from './http.mjs';
import {errorInfo} from '../errors.mjs';

export const devinRecordingInput = z.discriminatedUnion('action', [
  z.object({action:z.literal('connect'), serviceKey:z.string().min(1).max(1030), record:z.literal(true)}).strict(),
  z.object({action:z.literal('disconnect'), generation:z.string().uuid()}).strict(),
]);
export type DevinRecordingInput = z.infer<typeof devinRecordingInput>;

export async function devinRecordingRequest(req: IncomingMessage, options: {
  devinRecording?: DevinRecording; principal: Principal; member: DirectoryMembership; revalidate?: () => Promise<boolean>;
}) {
  const {devinRecording,principal,member,revalidate} = options;
  const failure = (status: number, message: string) => ({status,body:{error:{code:'DEVIN_RECORDING_FAILED',message}}});
  if (principal.owner || principal.captureAccess !== undefined || !member || member.status !== 'active' || member.userId !== principal.userId ||
      member.organizationId !== principal.tenantId || !isAdmin(member)) {
    return failure(403,'Only a workspace admin can change Devin recording.');
  }
  if (!devinRecording) return failure(503,'Devin recording is unavailable.');
  try {
    const parsed = devinRecordingInput.safeParse(await smallJson(req,4096));
    if (!parsed.success) return failure(400,'Choose a valid Devin recording action.');
    const input = parsed.data;
    const result = input.action === 'connect'
      ? await devinRecording.connect(principal,input.serviceKey,revalidate)
      : await devinRecording.disconnect(principal,input.generation,revalidate);
    return {status:200,body:result};
  } catch (error) {
    const info = errorInfo(error);
    if (info.expose && info.status) return failure(info.status,info.message);
    if (error instanceof DevinRateLimitError) return failure(429,'Devin is rate limiting requests. Try again shortly.');
    if (info.status === 403 || error instanceof DevinReadError && error.status === 401)
      return failure(403,'Use an organization service-user key that can read sessions, messages and session events.');
    return failure(503,'Could not reach Devin or save the connection. Try again shortly.');
  }
}
