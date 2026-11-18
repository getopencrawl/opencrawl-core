import {z} from 'zod';
import type {Principal} from '../identity/types.mjs';

const common={id:z.string().uuid(),at:z.iso.datetime(),harness:z.enum(['codex','claude-code','cursor','antigravity','devin'])};
const identity={eventKey:z.string().regex(/^[a-f0-9]{64}$/),sessionHash:z.string().regex(/^[a-f0-9]{64}$/)};
const checkId=z.string().uuid();
const reason=z.enum(['capacity','superseded','expired','excluded','unavailable','timeout','invalid_response','profile_changed','empty','write_failed']);
export const suggestionEventSchema=z.discriminatedUnion('stage',[
  z.object({...common,...identity,stage:z.literal('observed')}).strict(),
  z.object({...common,...identity,stage:z.enum(['skipped','dropped']),reason,checkId:checkId.optional()}).strict(),
  z.object({...common,...identity,stage:z.literal('requested'),replay:z.boolean()}).strict(),
  z.object({...common,...identity,stage:z.literal('received'),checkId:checkId.optional(),results:z.number().int().min(0).max(5),outputTokens:z.number().int().min(0).max(1600),latencyMs:z.number().int().min(0).max(30000),replay:z.boolean()}).strict(),
  z.object({...common,...identity,stage:z.literal('handoff'),checkId:checkId.optional(),results:z.number().int().min(1).max(5)}).strict(),
  z.object({...common,stage:z.literal('feedback'),checkId,rating:z.enum(['useful','irrelevant','distracting','stale','duplicate']),source:z.enum(['user','agent']),resultIndex:z.number().int().min(0).max(4).optional()}).strict(),
]);
export type SuggestionEvent=z.infer<typeof suggestionEventSchema>;
export type SuggestionObserver=(principal:Principal,events:SuggestionEvent[])=>Promise<void>;
export const suggestionEventsSchema=z.object({events:z.array(suggestionEventSchema).min(1).max(24)}).strict();

/** Deployment-owned observation. Identity comes from authentication, never the payload.
 * Events are client reports, not proof that the model consumed or benefited from text. */
export function createSuggestionEvents({authorize,observe,now=Date.now}:{authorize:(p:Principal)=>Promise<unknown>;observe?:SuggestionObserver;now?:()=>number}) {
  return async(p:Principal,raw:unknown)=>{
    if(!p?.tenantId||!p.userId||p.captureAccess!==undefined)throw Object.assign(Error('Workspace access required'),{status:403});
    const parsed=suggestionEventsSchema.safeParse(raw);
    if(!parsed.success)throw Object.assign(Error('Invalid suggestion events'),{status:400});
    const events=parsed.data.events,time=now();
    if(events.some(e=>Date.parse(e.at)<time-86400000||Date.parse(e.at)>time+300000)||new Set(events.map(e=>e.id)).size!==events.length)throw Object.assign(Error('Invalid event window'),{status:400});
    await authorize(p);
    await observe?.(p,events);
    await authorize(p);
    return {accepted:events.map(e=>e.id),observed:Boolean(observe)};
  };
}
