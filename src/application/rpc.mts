import type {IncomingMessage} from 'node:http';
import {initTRPC, TRPCError, type AnyRouter} from '@trpc/server';
import {fetchRequestHandler} from '@trpc/server/adapters/fetch';
import {z} from 'zod';
import {libraryOperations} from '../sessions/library-http.mjs';
import type {Bootstrap, TeamReport, SourceCard} from './types.mjs';
import type {UsageReport, DiagnosticSearch, BoardReport, OnboardingStatus, OnboardingSource, InvitationList, LibraryContract} from './types.mjs';

export interface WebContext {invoke<T>(path: string, method?: 'GET' | 'POST', input?: object): Promise<T>}
export const webRpc = initTRPC.context<WebContext>().create({errorFormatter: ({shape}) => ({...shape,
  message:shape.data.code === 'INTERNAL_SERVER_ERROR' ? 'This information is temporarily unavailable. Try again.' : shape.message,
  data: {...shape.data, stack: undefined}})});
const t = webRpc;
const p = t.procedure;
export const empty = z.object({}).strict().optional();
const provider = z.string().regex(/^[a-z0-9-]{1,40}$/);
const email = z.object({email: z.string().max(254)}).strict();
export function productRoutes<B extends Bootstrap = Bootstrap, T extends TeamReport = TeamReport>() {return {
  console: {
    bootstrap: p.input(empty).query(({ctx}) => ctx.invoke<B>('/api/console/bootstrap')),
    usage: p.input(empty).query(({ctx}) => ctx.invoke<UsageReport>('/api/console/usage')),
    sources: p.input(empty).query(({ctx}) => ctx.invoke<{items: SourceCard[]}>('/api/console/sources')),
    team: p.input(empty).query(({ctx}) => ctx.invoke<T>('/api/console/team')),
    invite: p.input(email).mutation(({ctx,input}) => ctx.invoke<{ok: true}>('/api/console/team/invite','POST',input)),
    changeRole: p.input(z.object({userId:z.string(),role:z.enum(['admin','member'])}).strict()).mutation(({ctx,input}) => ctx.invoke<{ok:true;userId:string;role:'admin'|'member'}>('/api/console/team/role','POST',input)),
    removeMember: p.input(z.object({userId:z.string()}).strict()).mutation(({ctx,input})=>ctx.invoke<{ok:true;userId:string}>('/api/console/team/remove','POST',input)),
    rename: p.input(z.object({name:z.string().max(100)}).strict()).mutation(({ctx,input}) => ctx.invoke<{ok:true;name:string}>('/api/console/team/organization','POST',input)),
  },
  diagnostics: t.router({
    search: p.input(z.object({query:z.string().max(4000)}).strict()).query(({ctx,input}) => ctx.invoke<DiagnosticSearch>('/api/debug/search','POST',input)),
    board: p.input(z.object({topic:z.string().max(200).optional(),before:z.number().int().positive().optional()}).strict()).query(({ctx,input}) => ctx.invoke<BoardReport>('/api/debug/board'+(Object.keys(input).length?'?'+new URLSearchParams(Object.entries(input).map(([k,v])=>[k,String(v)])) : ''))),
  }),
  library: t.router({
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
    status: p.input(empty).query(({ctx})=>ctx.invoke<{data:OnboardingStatus}>('/api/onboarding')),
    sources: p.input(empty).query(({ctx})=>ctx.invoke<{items:OnboardingSource[]}>('/api/onboarding/sources')),
    invitations: p.input(empty).query(({ctx})=>ctx.invoke<InvitationList>('/api/onboarding/invites')),
    invite: p.input(email).mutation(({ctx,input})=>ctx.invoke<InvitationList>('/api/onboarding/invites','POST',input)),
    finish: p.input(empty).mutation(({ctx})=>ctx.invoke<{workspaceUrl:string}>('/api/onboarding/finish','POST',{})),
  }),
  integrations: t.router({
    connect: p.input(z.object({provider,apiKey:z.string().max(4000).optional()}).strict()).mutation(({ctx,input})=>ctx.invoke<{ok?:boolean;redirectUrl?:string}>('/api/integrations/'+input.provider+'/connect','POST',{apiKey:input.apiKey})),
    retry: p.input(z.object({provider}).strict()).mutation(({ctx,input})=>ctx.invoke<{ok:true}>('/api/integrations/'+input.provider+'/retry','POST',{})),
    disconnect: p.input(z.object({provider}).strict()).mutation(({ctx,input})=>ctx.invoke<{ok:true}>('/api/integrations/'+input.provider+'/disconnect','POST',{})),
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
  const response = await fetchRequestHandler({endpoint:'/api/trpc',req:request,router,createContext:()=>context,maxBatchSize:8,allowBatching:true,allowMethodOverride:true});
  const body = await response.text();
  if (!await revalidate()) {
    const error={error:{message:'Workspace access changed. Sign in again.',code:-32003,data:{code:'FORBIDDEN',httpStatus:403}}};
    return {status:403,body:JSON.stringify(url.searchParams.get('batch')==='1'?url.pathname.slice('/api/trpc/'.length).split(',').map(()=>error):error)};
  }
  return {status:response.status,body};
}
