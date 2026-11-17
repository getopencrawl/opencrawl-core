import type {SessionBatch, SessionEvent} from './types.mjs';
import {record} from './replicas-record.mjs';

export const TITLE_KINDS = ['session_title', 'title', 'session_metadata'];

/** Only explicit native title metadata can name a session. */
export function capturedTitle(event: SessionEvent, batch?: SessionBatch): string | null {
  if(event.kind==='replicas_history_page'){
    const conversation=record(record(event.data?.replicasPage)?.conversation),title=conversation?.title;
    return typeof title==='string'&&title.trim()?title.trim():null;
  }
  if (!TITLE_KINDS.includes(event.kind)) return null;
  for (const value of [event.data?.customTitle, event.data?.title, event.data?.aiTitle, batch?.title]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
