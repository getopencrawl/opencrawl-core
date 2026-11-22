import type {SessionEvent} from '../sessions/types.mjs';
import {maskPatterns} from '../sessions/credential-patterns.mjs';
import type {DevinEventRequest} from './devin-first-turn.mjs';
import {checkDevinDetailHeader, checkedDevinEventDetail, firstTurnDevinEvent, readDevinEventPage} from './devin-session-events.mjs';

type ReadEvents = (request: DevinEventRequest) => Promise<string>;
const shellEvents = new Set(['shell_process_started','shell_process_completed','shell_process_completed_background']);
const toolCategories = new Set(['file','editor','browser','mcp','tool','terminal','shell']);

/** A window stays fixed across provider pagination. Only tool activity gets
 * projected. Internal reasoning and status notifications never enter capture. */
export async function readDevinToolPage(read: ReadEvents, sessionId: string, fromMs: number, throughMs: number, after?: string,
  previouslyStored?: (ids: string[]) => Promise<Set<string>>) {
  const first = 12;
  const listing = await read({
    action:'list', session_id:sessionId, first,
    created_after:Math.floor(fromMs / 1000) - 1, created_before:Math.ceil(throughMs / 1000) + 1,
    ...(after ? {after} : {}),
  });
  const page = readDevinEventPage(listing);
  if (page.records.length > first || (after && page.after === after)) throw new Error('Invalid Devin event page.');
  const events: SessionEvent[] = [];
  const candidates = page.records.filter(item => toolCategories.has(item.category) && item.second+999 >= fromMs &&
    item.second <= throughMs && (item.category!=='shell' || shellEvents.has(item.type)));
  const known = candidates.length && previouslyStored ? await previouslyStored(candidates.map(item=>'devin-event:'+item.id)) : new Set<string>();
  for (const item of candidates) {
    const id = 'devin-event:'+item.id;
    if (known.has(id)) continue;
    if (item.category === 'shell') {
      const detail = await checkedDevinEventDetail(read, sessionId, item);
      const at = Date.parse(detail.timestamp);
      if (at < fromMs || at > throughMs) continue;
      const event = firstTurnDevinEvent(detail);
      if (!event?.data) throw new Error('Devin returned an incomplete shell receipt.');
      // Only command, directory and provider output can contain captured text.
      const input = event.data.input as {command:string; workdir?:string} | undefined;
      if (input) {
        input.command = maskPatterns(input.command);
        if (input.workdir) input.workdir = maskPatterns(input.workdir);
      }
      if (typeof event.data.output === 'string') event.data.output = maskPatterns(event.data.output);
      events.push(event);
    } else {
      // Only the authenticated detail envelope is needed to verify this row.
      // Large file/browser payloads may be truncated and are never projected.
      if (item.second < fromMs || item.second+999 > throughMs) continue;
      const response = await read({action:'details', session_id:sessionId, event_ids:[item.id], max_content_length:256});
      checkDevinDetailHeader(response,item);
      events.push({id, nativeId:item.id, kind:'activity', timestamp:new Date(item.second).toISOString(),
        data:{name:item.category, summary:item.type, providerEventType:item.type}});
    }
  }
  return {events, after:page.after};
}
