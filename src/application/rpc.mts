import {activityRequest,historyRead,type SearchActivityPage,type CallTotals} from './search-activity.mjs';
import {tokenRangeInput,usageRange, tokenSessionsRequest, type TokenUsage, type TokenSessionPage} from './usage-range.mjs';
import {replicasImportInput} from './replicas-import-http.mjs';
import {devinRecordingInput} from './devin-recording-http.mjs';
import type {IncomingMessage} from 'node:http';
import {initTRPC, TRPCError, type AnyRouter} from '@trpc/server';
import {fetchRequestHandler} from '@trpc/server/adapters/fetch';
import {z} from 'zod';
import {libraryOperations} from '../sessions/library-http.mjs';
import type {Bootstrap, TeamReport, SourceCard} from './types.mjs';
import {MAX_SEARCH_PAGE} from './search-page.mjs';
import type {UsageReport, DiagnosticSearch, BoardReport, OnboardingStatus, OnboardingSource, InvitationList, LibraryContract} from './types.mjs';

import {maxReloadReportBytes, type ConsoleReloadCache} from './console-reload.mjs';
export interface WebContext {reload?: {cache: ConsoleReloadCache; tenant: string; scope: string}; usageSections?: boolean; invoke<T>(path: string, method?: 'GET' | 'POST', input?: object): Promise<T>}
export const webRpc = initTRPC.context<WebContext>().create({errorFormatter: ({shape}) => ({...shape,
  message:shape.data.code === 'INTERNAL_SERVER_ERROR' ? 'This information is temporarily unavailable. Try again.' : shape.message,
  data: {...shape.data, stack: undefined}})});
const t = webRpc;
const p = t.procedure;
export const empty = z.object({}).strict().optional();
const rangeOnly = z.strictObject({range: usageRange.optional()}).optional().transform(value => value ?? {});
const provider = z.string().regex(/^[a-z0-9-]{1,40}$/);
const email = z.object({email: z.string().max(254)}).strict();
export function productRoutes<B extends Bootstrap = Bootstrap, T extends TeamReport = TeamReport>() {return {
  console: {
    bootstrap: p.input(empty).query(({ctx}) => ctx.invoke<B>('/api/console/bootstrap')),
    usage: p.input(empty).query(async ({ctx}) => {
      const report = await ctx.invoke<UsageReport>('/api/console/usage');
      // Already-open older clients assume activity always has an overlap chart.
      // Keep their previous error/cache behavior until they load the new assets.
      if (!ctx.usageSections && report.agents && !report.overlap) throw rpcError(503, 'Usage couldn’t update. Reload this page to retry.');
      return report;
    }),
    usageHighlights: p.input(empty).query(({ctx}) => ctx.invoke<import('./reports.mjs').UsageHighlights & {cacheScope: string}>('/api/console/usage/highlights')),
    callTotals:p.input(activityRequest.optional().transform(value => value ?? {})).query(({ctx,input})=>ctx.invoke<CallTotals & {cacheScope:string}>('/api/console/usage/calls','POST',input)),
    usageTokens:p.input(tokenRangeInput).query(({ctx,input})=>ctx.invoke<TokenUsage & {cacheScope:string}>('/api/console/usage/tokens','POST',input)),
    tokenSessions:p.input(tokenSessionsRequest).query(({ctx,input})=>ctx.invoke<TokenSessionPage & {cacheScope:string}>('/api/console/usage/token-sessions','POST',input)),
    searchHistory:p.input(historyRead).query(({ctx,input})=>ctx.invoke<SearchActivityPage & {cacheScope:string}>('/api/console/usage/search-history','POST',input)),
    usageDetails: p.input(rangeOnly).query(({ctx,input}) => ctx.invoke<import('./reports.mjs').UsageDetails & {cacheScope: string}>('/api/console/usage/details','POST',input)),
    fileView:p.input(z.strictObject({path:z.string().min(1).max(8192)})).query(({ctx,input})=>ctx.invoke<import('./file-links.mjs').FileView>('/api/console/files/view','POST',input)),
    connection:p.input(z.strictObject({path:z.string().max(100)})).query(({ctx,input})=>ctx.invoke<SourceCard>('/api/console/sources/connection','POST',input)),
    sources: p.input(empty).query(({ctx}) => ctx.invoke<{items: SourceCard[]}>('/api/console/sources')),
    team: p.input(empty).query(({ctx}) => ctx.invoke<T>('/api/console/team')),
    invite: p.input(email).mutation(({ctx,input}) => ctx.invoke<{ok: true; inviteUrl?: string}>('/api/console/team/invite','POST',input)),
    changeRole: p.input(z.object({userId:z.string(),role:z.enum(['admin','member'])}).strict()).mutation(({ctx,input}) => ctx.invoke<{ok:true;userId:string;role:'admin'|'member'}>('/api/console/team/role','POST',input)),
    removeMember: p.input(z.object({userId:z.string()}).strict()).mutation(({ctx,input})=>ctx.invoke<{ok:true;userId:string}>('/api/console/team/remove','POST',input)),
    rename: p.input(z.object({name:z.string().max(100)}).strict()).mutation(({ctx,input}) => ctx.invoke<{ok:true;name:string}>('/api/console/team/organization','POST',input)),
  },
  diagnostics: t.router({
    search: p.input(z.object({query:z.string().max(4000),page:z.number().int().min(1).max(MAX_SEARCH_PAGE).optional()}).strict()).query(({ctx,input}) => ctx.invoke<DiagnosticSearch>('/api/debug/search','POST',input)),
    boardDestination:p.input(z.strictObject({path:z.string().max(1600)})).query(({ctx,input})=>ctx.invoke<import('./board-links.mjs').BoardDestination>('/api/debug/board?'+new URLSearchParams({destination:input.path}))),
    board: p.input(z.object({workspaceKey:z.string().length(12).optional(),query:z.string().trim().min(1).max(500).optional(),cursor:z.string().max(100).optional(),channel:z.string().max(80).optional(),threadId:z.number().int().positive().optional(),rootsOnly:z.boolean().optional(),topic:z.string().max(200).optional(),before:z.number().int().positive().optional()}).strict()).query(({ctx,input}) => ctx.invoke<BoardReport>('/api/debug/board'+(Object.keys(input).length?'?'+new URLSearchParams(Object.entries(input).map(([k,v])=>[k,String(v)])) : ''))),
  }),
  library: t.router({
    privacy: t.router({
      status:p.input(libraryOperations['privacy/status']).query(({ctx,input})=>ctx.invoke<LibraryContract['privacy/status']['output']>('/api/console/library/privacy/status','POST',input)),
      change:p.input(libraryOperations['privacy/change']).mutation(({ctx,input})=>ctx.invoke<LibraryContract['privacy/change']['output']>('/api/console/library/privacy/change','POST',input)),
    }),
    recording: t.router({
      status:p.input(libraryOperations['recording/status']).query(({ctx,input})=>ctx.invoke<LibraryContract['recording/status']['output']>('/api/console/library/recording/status','POST',input)),
      change:p.input(libraryOperations['recording/change']).mutation(({ctx,input})=>ctx.invoke<LibraryContract['recording/change']['output']>('/api/console/library/recording/change','POST',input)),
    }),
    sessions: t.router({
      list:p.input(libraryOperations['sessions/list']).query(({ctx,input})=>ctx.invoke<LibraryContract['sessions/list']['output']>('/api/console/library/sessions/list','POST',input)),
      read:p.input(libraryOperations['sessions/read']).query(({ctx,input})=>ctx.invoke<LibraryContract['sessions/read']['output']>('/api/console/library/sessions/read','POST',input)),
      visibility:p.input(libraryOperations['sessions/visibility']).mutation(({ctx,input})=>ctx.invoke<LibraryContract['sessions/visibility']['output']>('/api/console/library/sessions/visibility','POST',input)),
      delete:p.input(libraryOperations['sessions/delete']).mutation(({ctx,input})=>ctx.invoke<LibraryContract['sessions/delete']['output']>('/api/console/library/sessions/delete','POST',input)),
    }),
    memories: t.router({
      list:p.input(libraryOperations['memories/list']).query(({ctx,input})=>ctx.invoke<LibraryContract['memories/list']['output']>('/api/console/library/memories/list','POST',input)),
      read:p.input(libraryOperations['memories/read']).query(({ctx,input})=>ctx.invoke<LibraryContract['memories/read']['output']>('/api/console/library/memories/read','POST',input)),
      visibility:p.input(libraryOperations['memories/visibility']).mutation(({ctx,input})=>ctx.invoke<LibraryContract['memories/visibility']['output']>('/api/console/library/memories/visibility','POST',input)),
      delete:p.input(libraryOperations['memories/delete']).mutation(({ctx,input})=>ctx.invoke<LibraryContract['memories/delete']['output']>('/api/console/library/memories/delete','POST',input)),
    }),
  }),
  onboarding: t.router({
    replicasSetup: p.input(empty).mutation(({ctx})=>ctx.invoke<{prompt:string;expiresAt:string}>('/api/console/replicas/setup','POST',{})),
    status: p.input(empty).query(({ctx})=>ctx.invoke<{data:OnboardingStatus}>('/api/onboarding')),
    sources: p.input(empty).query(({ctx})=>ctx.invoke<{items:OnboardingSource[]}>('/api/onboarding/sources')),
    invitations: p.input(empty).query(({ctx})=>ctx.invoke<InvitationList>('/api/onboarding/invites')),
    invite: p.input(email).mutation(({ctx,input})=>ctx.invoke<InvitationList>('/api/onboarding/invites','POST',input)),
    finish: p.input(empty).mutation(({ctx})=>ctx.invoke<{workspaceUrl:string}>('/api/onboarding/finish','POST',{})),
  }),
  integrations: t.router({
    replicasHistory:p.input(replicasImportInput).mutation(({ctx,input})=>ctx.invoke<import('../integrations/replicas-import.mjs').ReplicasImportStatus>('/api/integrations/replicas/history','POST',input)),
    devinRecording:p.input(devinRecordingInput).mutation(({ctx,input})=>ctx.invoke<import('../integrations/devin-recording.mjs').DevinRecordingStatus>('/api/integrations/devin/recording','POST',input)),
    connect: p.input(z.object({provider,apiKey:z.string().max(4000).optional()}).strict()).mutation(({ctx,input})=>ctx.invoke<{ok?:boolean;redirectUrl?:string}>('/api/integrations/'+input.provider+'/connect','POST',{apiKey:input.apiKey})),
    retry: p.input(z.object({provider,integrationId:z.string().regex(/^int_[a-f0-9]{26}$/).optional()}).strict()).mutation(({ctx,input})=>ctx.invoke<{ok:true}>('/api/integrations/'+input.provider+'/retry','POST',{integrationId:input.integrationId})),
    disconnect: p.input(z.object({provider,integrationId:z.string().regex(/^int_[a-f0-9]{26}$/).optional()}).strict()).mutation(({ctx,input})=>ctx.invoke<{ok:true}>('/api/integrations/'+input.provider+'/disconnect','POST',{integrationId:input.integrationId})),
    saveCredential: p.input(z.object({credential:provider,value:z.string().min(1).max(4000)}).strict()).mutation(({ctx,input})=>ctx.invoke<{ok:true}>('/api/integrations/credentials/'+input.credential,'POST',{value:input.value})),
  }),
};}
const routes = productRoutes();
export const productRouter = t.router({...routes, console: t.router(routes.console)});
export type ProductRouter = typeof productRouter;
export function rpcError(status: number, message: string) {
  const code = status === 400 ? 'BAD_REQUEST' : status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'SERVICE_UNAVAILABLE';
  return new TRPCError({code,message});
}

/** Buffer the entire batch, then check current access once before returning any private data. */
export async function handleProductRpc<R extends AnyRouter>(req: IncomingMessage, url: URL, router: R, context: WebContext, revalidate: () => Promise<boolean>) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {size += chunk.length; if(size>65_536) throw rpcError(400,'This request is too large.');chunks.push(Buffer.from(chunk));}
  const headers = new Headers();
  if(req.headers['content-type'])headers.set('content-type',req.headers['content-type']);
  // Never stream procedure results ahead of the batch's final authorization barrier.
  headers.set('accept','application/json');
  const request = new Request(url,{method:req.method,headers,...req.method==='POST'?{body:Buffer.concat(chunks).toString('utf8')}:{}});
  const binding = context.reload;
  const operation = url.pathname.slice('/api/trpc/'.length);
  const remember = !url.searchParams.has('batch') && binding?.cache.begin(binding.tenant, binding.scope, operation);
  // The internal HTTP method distinguishes writes from tRPC's POST transport.
  const invoke: WebContext['invoke'] = async <T,>(path: string, method?: 'GET' | 'POST', input?: object) => {
    const write = binding && method === 'POST' && path !== '/api/debug/search'
      && path !== '/api/console/library/privacy/status' && path !== '/api/console/library/recording/status' && !/^\/api\/console\/library\/(sessions|memories)\/(list|read)$/.test(path)
      // Usage reads send their range and page in a POST body; they change nothing.
      && !/^\/api\/console\/usage(\/[a-z-]+)?$/.test(path);
    if (write) binding.cache.invalidate(binding.tenant);
    try {return await context.invoke<T>(path, method, input);}
    finally {if (write) binding.cache.invalidate(binding.tenant);}
  };
  const response = await fetchRequestHandler({endpoint:'/api/trpc',req:request,router,createContext:()=>({...context,invoke,usageSections:req.headers['x-opencrawl-usage-sections']==='1'}),maxBatchSize:8,allowBatching:true,allowMethodOverride:true});
  const body = await response.text();
  if (!await revalidate()) {
    if (binding) binding.cache.invalidate(binding.tenant);
    const error={error:{message:'Workspace access changed. Sign in again.',code:-32003,data:{code:'FORBIDDEN',httpStatus:403}}};
    return {status:403,body:JSON.stringify(url.searchParams.get('batch')==='1'?url.pathname.slice('/api/trpc/'.length).split(',').map(()=>error):error)};
  }
  if (remember && response.status === 200) {
    const data = body.length <= maxReloadReportBytes + 64 ? JSON.parse(body).result?.data : undefined;
    // A reload opens Usage on its default range; another range's report must not stand in for it.
    if (operation !== 'console.usageDetails' || data?.days === 30) remember(data);
  }
  if (binding && [401,402,403,404,409].includes(response.status)) binding.cache.invalidate(binding.tenant);
  return {status:response.status,body};
}
