import {z} from 'zod';
import {channelSchema,channelNames} from './channels.mjs';
import type {Principal} from '../sessions/types.mjs';
import type {ApplicationState} from '../state/types.mjs';
import {createHash} from 'node:crypto';
const text = (max: number) => z.string().trim().min(1).max(max);
export const boardSearchSchema = z.strictObject({
  workspace: text(200).optional().describe('Optional workspace; defaults to the authenticated workspace and must be authorized by the deployment.'), query: z.string().trim().max(500).default(''),
  channels: z.array(channelSchema).max(8).optional(),
  topics: z.array(text(80)).max(8).optional().describe('Deprecated alias for channels.'),
  agents: z.array(text(80)).max(8).default([]),
  authors: z.array(text(200)).max(8).default([]),
  since: z.iso.datetime({offset: true}).optional(), until: z.iso.datetime({offset: true}).optional(),
  sort: z.enum(['relevance', 'newest']).default('relevance'),
  limit: z.number().int().min(1).max(10).default(5),
  facets: z.array(z.enum(['topic', 'agent', 'author', 'day'])).max(4).default(['topic', 'agent']),
  facetSize: z.number().int().min(1).max(8).default(5),
  cursor: text(100).optional().describe('Next page; repeat the same query and filters. Expires after five minutes.'),
});
export {boardIndexMapping} from '../search/mapping.mjs';
/** PostgreSQL is authoritative for board text and durable cursor snapshots. */
export function createBoardSearch({state,now=Date.now}:{state:ApplicationState;now?:()=>number}){
  if(!state?.board)throw Object.assign(new Error('PostgreSQL board state is required'),{status:503});
  return {async search(principal:Principal,input:unknown){
    if(principal?.captureAccess!==undefined||!principal?.tenantId||!principal?.userId)throw Object.assign(new Error('Workspace scope mismatch'),{status:403});
    const {workspace,...args}=boardSearchSchema.parse(input);
    if(workspace!==undefined&&workspace!==principal.tenantId)throw Object.assign(new Error('Workspace scope mismatch'),{status:403});
    if(args.since&&args.until&&Date.parse(args.since)>Date.parse(args.until))throw Object.assign(new Error('since must not be later than until'),{status:400});
    return state.board.search(createHash('sha256').update(principal.tenantId).digest('hex'),principal.userId,{...args,topics:channelNames(args)},now());
  }};
}
