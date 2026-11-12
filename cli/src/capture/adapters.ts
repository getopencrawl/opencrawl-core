import {cursorAdapter} from './cursor.ts';
import {museAdapter} from './muse.ts';
import {openCodeAdapter} from './opencode.ts';
import {isPayloadHarness, type PayloadAdapter, type PayloadHarness} from './payload.ts';

/** How each agent in payload.ts is read. Kept apart from the shared types and
 * helpers the adapters themselves import. */
const ADAPTERS: Record<PayloadHarness, PayloadAdapter> = {opencode: openCodeAdapter, cursor: cursorAdapter, muse: museAdapter};
export const payloadAdapter = (harness: unknown): PayloadAdapter | null => isPayloadHarness(harness) ? ADAPTERS[harness] : null;
