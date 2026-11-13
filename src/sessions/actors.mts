import type {SessionBatch,SessionEvent} from './types.mjs';

/** Provenance reported by a capture client. It never changes the authenticated
 * uploader, resource owner, tenant, permissions or human onboarding receipts. */
export interface CapturedActor {
 provider:'replicas';assurance:'collector-reported';kind:'human'|'unknown';
 workspaceId:string;messageId:string;nativeId:string;userId?:string;name?:string;email?:string;
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const label=(value:unknown,max:number)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f]/.test(value)?value:undefined;
export function capturedActor(event:SessionEvent,batch:Pick<SessionBatch,'actorProfiles'>):CapturedActor|undefined {
 if(event.kind!=='message'||event.data?.role!=='user')return;
 const actor=object(event.actor);
 if(actor.provider!=='replicas'||actor.assurance!=='collector-reported'||!['human','unknown'].includes(String(actor.kind))||
  !uuid(actor.workspaceId)||!uuid(actor.nativeId)||typeof actor.messageId!=='string'||!/^[A-Za-z0-9_.:-]{1,200}$/.test(actor.messageId)||actor.kind==='human'&&!uuid(actor.userId))return;
 const result:CapturedActor={provider:'replicas',assurance:'collector-reported',kind:actor.kind as 'human'|'unknown',workspaceId:actor.workspaceId,nativeId:actor.nativeId,messageId:actor.messageId};
 if(actor.kind==='human'){
  result.userId=actor.userId as string;
  const profile=object(object(batch.actorProfiles)[result.userId]);
  if(profile.provider==='replicas'&&profile.userId===result.userId){
   const name=label(profile.name,256),email=label(profile.email,320);
   if(name)result.name=name;if(email)result.email=email;
  }
 }
 return result;
}
