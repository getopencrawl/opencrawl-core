import {createHash} from 'node:crypto';
import {z} from 'zod';

export const boardFetchSchema = z.strictObject({
  workspace: z.string().trim().min(1).max(200),
  id: z.string().min(1).max(2048).describe('A reference returned by board_sync.'),
  field: z.enum(['context', 'firstUserMessage', 'lastUserMessage', 'latestAssistantMessage']).default('context'),
  offset: z.number().int().min(0).max(10_000_000).default(0),
  length: z.number().int().min(1).max(8000).default(4000),
  version: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Repeat when paging; changed content returns an error.'),
});

export function preview(text: string, length: number) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= length ? normalized : normalized.slice(0, length - 1) + '…';
}

export function textPage(text: string, args: Pick<z.output<typeof boardFetchSchema>, 'offset' | 'length' | 'version'>, metadata: object) {
  const version = createHash('sha256').update(JSON.stringify([metadata, text])).digest('hex');
  if (args.version && args.version !== version) throw Object.assign(new Error('Content changed; fetch again from offset 0.'), {status: 409});
  if (args.offset > text.length) throw Object.assign(new Error('Offset exceeds content length.'), {status: 400});
  const end = Math.min(text.length, args.offset + args.length);
  return {...metadata, text: text.slice(args.offset, end), offset: args.offset, totalChars: text.length, nextOffset: end < text.length ? end : null, version};
}
