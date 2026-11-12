import type {IncomingMessage} from 'node:http';
import type {SourceCard, TeamReport, InvitationPolicy} from './types.mjs';

export type Principal = {tenantId: string; userId: string};
export type User = {id: string; email: string; firstName?: string | null; lastName?: string | null};
export type Membership = {userId: string; organizationId: string; status: string; role?: {slug: string}; roles?: Array<{slug: string}>; directoryManaged?:boolean};
export type Organization = {id: string; name: string; metadata?: Record<string, string>};
type Progress = {completed?: {observedAt?: string} | null};
export interface ConsoleContext {principal: Principal; user: User; member: Membership; revalidate: () => Promise<boolean>; admitted?: boolean; cacheScope?: string}
export interface ConsoleServices {
  url: string;
  setupPrompt: string;
  invitationPolicy?: InvitationPolicy;
  organization: (id: string) => Promise<Organization>;
  members: (id: string) => Promise<Membership[]>;
  user: (id: string) => Promise<User>;
  invitations: (user: User, id: string, member: Membership) => Promise<Array<{email: string; inviteUrl?: string}>>;
  invite: (user: User, id: string, email: string) => Promise<unknown>;
  changeRole: (user: User, id: string, userId: string, role: 'admin' | 'member') => Promise<{ok:true; userId:string; role:'admin' | 'member'}>;
  removeMember: (user: User, id: string, userId: string) => Promise<{ok:true;userId:string}>;
  renameOrganization: (user: User, id: string, name: string) => Promise<{ok:true;name:string}>;
  sources: (principal: Principal) => Promise<SourceCard[]>;
  usage: (principal: Principal) => Promise<unknown>;
  progress: (principal: Principal) => Promise<Progress | null>;
  next: (principal: Principal) => Promise<string>;
  /** Core session and memory library; the core API validates input and enforces ownership and privacy. */
  library: null | ((principal: Principal, operation: string, input: unknown) => Promise<unknown>);
  libraryFailure: (error: unknown) => {status: number; message: string};
}
const LIBRARY = /^\/api\/console\/library\/((?:sessions|memories)\/(?:list|read|visibility|delete))$/;
export const consolePages = new Set(['/', '/usage', '/sessions', '/memories', '/sources', '/integrations', '/data', '/diagnostics', '/settings', '/team', '/search', '/_/debug', '/_/debug/', '/onboarding', '/onboarding/sources', '/onboarding/invite']);
export function consoleRoute(method: string, path: string) {
  if (['/api/console/bootstrap','/api/console/sources','/api/console/usage','/api/console/team'].includes(path)) return {name:path, ...(method === 'GET' ? {} : {status:405})};
  if (['/api/console/team/invite','/api/console/team/role','/api/console/team/remove','/api/console/team/organization'].includes(path)) return {name:path, ...(method === 'POST' ? {} : {status:405})};
  if (['/sources','/data','/diagnostics','/settings','/sessions','/memories'].includes(path)) return {name:path, ...(method === 'GET' ? {} : {status:405})};
  if (LIBRARY.test(path)) return {name:path, ...(method === 'POST' ? {} : {status:405})};
  return null;
}
export function consoleDocument(data?: {page: {kind:string}; signedIn:boolean}) {
  // Only inert JSON crosses the server/browser boundary. All visible UI is React.
  const bootstrap = data ? `<script id="opencrawl-page" type="application/json">${JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4,'0'))}</script>` : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#000"><title>OpenCrawl</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="preload" href="/assets/geist-sans.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/console/assets/app.css"><script type="module" src="/console/assets/app.js"></script></head><body><div id="root"></div>' + bootstrap + '<noscript>OpenCrawl needs JavaScript to manage your workspace. Enable it and reload this page.</noscript></body></html>';
}
export const admin = (member: Membership) => [member.role,...member.roles || []].some(role => role?.slug === 'admin');
export const consoleFailure = (status: number, message: string) => Object.assign(new Error(message), {status, expose:true});
const name = (user: User) => [user.firstName,user.lastName].filter(Boolean).join(' ').trim() || user.email;
/** Display names for current members only; departed members keep their opaque ID. */
async function authorNames(services: ConsoleServices, principal: Principal, body: unknown) {
  const ids = new Set<string>();
  const visit = (value: unknown) => {if (value && typeof value === 'object' && 'userId' in value && typeof value.userId === 'string') ids.add(value.userId);};
  if (body && typeof body === 'object') for (const key of ['sessions','memories','session','memory']) {const value = (body as Record<string, unknown>)[key]; if (Array.isArray(value)) value.forEach(visit); else visit(value);}
  ids.delete(principal.userId);
  if (!ids.size) return {};
  const current = new Set((await services.members(principal.tenantId)).map(member => member.userId));
  const people = await Promise.all([...ids].filter(id => current.has(id)).map(async id => [id, name(await services.user(id))] as const));
  return Object.fromEntries(people);
}
async function input(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {size += chunk.length; if (size > 4096) throw consoleFailure(413,'This request is too large.'); chunks.push(Buffer.from(chunk));}
  let value: unknown;
  try {value = JSON.parse(Buffer.concat(chunks).toString() || '{}');} catch {throw consoleFailure(400,'Enter a valid request.');}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw consoleFailure(400,'Enter a valid request.');
  return value as Record<string, unknown>;
}
export interface ConsoleExtensions {
  bootstrap?: (context: ConsoleContext) => Promise<Record<string, unknown>>;
  team?: (context: ConsoleContext) => Promise<Record<string, unknown>>;
  routes?: Record<string, (context: ConsoleContext) => Promise<unknown>>;
}
export function createConsoleApi(services: ConsoleServices, extensions: ConsoleExtensions = {}) {
  return async (req: IncomingMessage, path: string, context: ConsoleContext): Promise<{status: number; body: unknown}> => {
    const {principal,user,member,revalidate} = context;
    try {
      const url = new URL(req.url || path, services.url);
      if (url.search) throw consoleFailure(400,'This endpoint does not accept scope or query parameters.');
      if (!context.admitted && !await revalidate()) throw consoleFailure(403,'Workspace access changed. Sign in again.');
      let body: unknown;
      if (path === '/api/console/bootstrap') {
        const [organization, progress, extension] = await Promise.all([services.organization(principal.tenantId), services.progress(principal), extensions.bootstrap?.(context)]);
        const completed = Boolean(progress?.completed?.observedAt);
        body = {...extension,...(services.invitationPolicy?{invitationPolicy:services.invitationPolicy}:{}),cacheScope:context.cacheScope || [principal.tenantId,principal.userId,admin(member)?'admin':'member'].join(':'),workspace:{name:organization.name,userName:name(user),email:user.email,role:admin(member) ? 'admin' : 'member'}, mcpUrl:services.url + '/mcp',setupPrompt:services.setupPrompt,canInvite:admin(member),onboarding:{completed,next:completed ? '/' : await services.next(principal)}};
      } else if (path === '/api/console/usage') {
        body = await services.usage(principal);
      } else if (path === '/api/console/sources') {
        body = {items:await services.sources(principal)};
      } else if (path === '/api/console/team') {
        const [organization,members,extension,invitations] = await Promise.all([services.organization(principal.tenantId),services.members(principal.tenantId),extensions.team?.(context),admin(member) ? services.invitations(user,principal.tenantId,member) : []]);
        const users = await Promise.all(members.map(async membership => {const person = await services.user(membership.userId); return {id:person.id,name:name(person),email:person.email,role:admin(membership) ? 'admin' as const : 'member' as const,...(membership.directoryManaged?{directoryManaged:true}:{})};}));
        body = {...extension,organization:{id:organization.id,name:organization.name},viewerUserId:user.id,role:admin(member) ? 'admin' : 'member',members:users,invitations} satisfies TeamReport;
      } else if (path === '/api/console/team/invite') {
        if (!admin(member)) throw consoleFailure(403,'Only an organization admin can do that.');
        const payload = await input(req);
        if (Object.keys(payload).some(key => key !== 'email') || typeof payload.email !== 'string') throw consoleFailure(400,'Enter a teammate email address.');
        const invitation=await services.invite(user,principal.tenantId,payload.email);
        const inviteUrl=services.invitationPolicy?.delivery==='link'&&invitation&&typeof invitation==='object'&&'acceptInvitationUrl' in invitation&&typeof invitation.acceptInvitationUrl==='string'?invitation.acceptInvitationUrl:undefined;
        body = {ok:true,...(inviteUrl?{inviteUrl}:{})};
      } else if (path === '/api/console/team/role') {
        if (!admin(member)) throw consoleFailure(403,'Only an organization admin can do that.');
        const payload = await input(req);
        if (Object.keys(payload).some(key => !['userId','role'].includes(key)) || typeof payload.userId !== 'string' || !/^user_[A-Za-z0-9]+$/.test(payload.userId) || (payload.role !== 'admin' && payload.role !== 'member')) throw consoleFailure(400,'Choose an active teammate and Admin or Member.');
        if (payload.userId === user.id) throw consoleFailure(400,'You cannot change your own role.');
        body = await services.changeRole(user,principal.tenantId,payload.userId,payload.role);
      } else if (path === '/api/console/team/remove') {
        if(!admin(member))throw consoleFailure(403,'Only an organization admin can do that.');
        const payload=await input(req);
        if(Object.keys(payload).some(key=>key!=='userId')||typeof payload.userId!=='string'||!/^user_[A-Za-z0-9]+$/.test(payload.userId))throw consoleFailure(400,'Choose an active teammate.');
        if(payload.userId===user.id)throw consoleFailure(400,'You cannot remove yourself. Ask another admin to remove you.');
        body=await services.removeMember(user,principal.tenantId,payload.userId);
      } else if (path === '/api/console/team/organization') {
        if (!admin(member)) throw consoleFailure(403,'Only an organization admin can do that.');
        const payload = await input(req);
        if (Object.keys(payload).some(key => key !== 'name') || typeof payload.name !== 'string') throw consoleFailure(400,'Enter an organization name.');
        body = await services.renameOrganization(user,principal.tenantId,payload.name);
      } else if (LIBRARY.test(path)) {
        if (!services.library) throw consoleFailure(503,'Sessions and memories are not available in this workspace yet.');
        const operation = LIBRARY.exec(path)![1]!, payload = await input(req);
        try {body = await services.library(principal,operation,payload);}
        catch (error) {const {status,message} = services.libraryFailure(error); throw consoleFailure(status,message);}
        if (/\/(?:list|read)$/.test(operation) && body && typeof body === 'object') body = {...body,authors:await authorNames(services,principal,body)};
      } else if (extensions.routes && Object.hasOwn(extensions.routes, path)) body = await extensions.routes[path]!(context);
      else throw consoleFailure(404,'Page not found.');
      if (!await revalidate()) throw consoleFailure(403,'Workspace access changed. Sign in again.');
      return {status:200,body};
    } catch (error) {
      const safe = error instanceof Error && 'expose' in error && error.expose === true;
      const status = safe && 'status' in error && typeof error.status === 'number' ? error.status : 503;
      return {status,body:{error:{code:status === 403 ? 'WORKSPACE_ACCESS_DENIED' : 'CONSOLE_UNAVAILABLE',message:safe ? error.message : 'This information is temporarily unavailable. Please try again.'}}};
    }
  };
}
