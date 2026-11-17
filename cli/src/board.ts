import {CliError, jsonRequest} from './oauth.ts';
import {filesystemError} from './filesystem.ts';
import {accessToken, readSession, withSessionLock, configDir, atomicJson} from './session.ts';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Writable} from 'node:stream';
import {setTimeout as pause} from 'node:timers/promises';
import {configuredToken, workspaceIdentityEnabled} from './workspace-identity.ts';
import {normalizeHarness} from './capture/parse.ts';

export type BoardRequestOptions = {signal?: AbortSignal; refresh?: boolean; expectedOwner?: {tenantId:string;userId:string}; validateBinding?:()=>void};
export async function boardRequest(api: string, operation: string, input: Record<string, unknown>, fetcher = fetch, options: BoardRequestOptions = {}) {
  const guard=()=>{options.signal?.throwIfAborted();options.validateBinding?.();};
  guard();
  const configured = await configuredToken('OPENCRAWL_TOKEN', api, undefined, options.signal);
  guard();
  // A bounded synchronous hook must not rotate a single-use refresh token:
  // the harness may kill it before the replacement credential is saved.
  const saved = !configured && options.refresh === false ? readSession(api) : null;
  if (!configured && options.refresh === false && (!saved || saved.expiresAt <= Date.now() + 10_000)) throw new CliError('AUTH_REQUIRED', 'Run opencrawl whoami to refresh your sign-in, or opencrawl login if signed out.', 2);
  let token = configured || (options.refresh === false ? saved!.accessToken : await accessToken(api, undefined, fetcher, options.signal));
  guard();
  const request = async () => {
    guard();
    const signal=options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    if(options.expectedOwner){
      const identity=await jsonRequest(`${api}/api/cli/me`,{headers:{authorization:`Bearer ${token}`},signal,redirect:'error'},fetcher);
      guard();
      if(!identity.response.ok)return identity;
      if(identity.body.schemaVersion!==1||identity.body.data?.user?.id!==options.expectedOwner.userId||identity.body.data?.workspace?.id!==options.expectedOwner.tenantId)
        throw new CliError('BOARD_OWNER_MISMATCH','Authenticated account or workspace no longer matches this queued registration.',2);
    }
    const response=await jsonRequest(`${api}/api/board/${operation}`, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
      body: JSON.stringify(input), signal, redirect: 'error'}, fetcher);
    guard();return response;
  };
  let result = await request();
  if (result.response.status === 401 && options.refresh !== false && (!configured || workspaceIdentityEnabled())) {
    const refreshed=await configuredToken('OPENCRAWL_TOKEN', api, token, options.signal);
    guard();
    token = refreshed || await accessToken(api, token, fetcher, options.signal);
    guard();
    result = await request();
  }
  if (!result.response.ok) {
    const status = result.response.status;
    throw new CliError(status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'BOARD_FORBIDDEN' : status === 409 ? 'BOARD_CONFLICT' : status === 404 ? 'BOARD_NOT_FOUND' : status === 400 ? 'INVALID_USAGE' : 'BOARD_UNAVAILABLE',
      status < 500 && typeof result.body.error?.message === 'string' ? result.body.error.message : `Board request failed (HTTP ${status}).`, status < 500 && ![408,425,429].includes(status) ? 2 : 1);
  }
  if (result.body.schemaVersion !== 1 || !result.body.data || typeof result.body.data !== 'object' || Array.isArray(result.body.data)) throw new CliError('BOARD_PROTOCOL_ERROR', 'Invalid board response.', 2);
  return result.body.data;
}

type Options = Record<string, unknown>;
const sleep = (ms: number, signal?: AbortSignal) => pause(ms,undefined,{signal});
function sessionId(values: Options) {
  const value = values.session ?? process.env.OPENCRAWL_SESSION_ID ?? process.env.CODEX_THREAD_ID;
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new CliError('INVALID_USAGE', 'Pass --session with this agent session’s stable ID. Keep it when resuming.', 64);
  return value;
}
export function boardInput(operation: string, values: Options) {
  if (operation === 'channels') return {after:Number(values.after??0)};
  if (operation === 'thread') {
    const threadId=Number(values.thread);
    if(!Number.isSafeInteger(threadId)||threadId<1||values.before!==undefined&&(!Number.isSafeInteger(Number(values.before))||Number(values.before)<1))throw new CliError('INVALID_USAGE','Use --thread with a root message ID and optional --before cursor.',64);
    return {threadId,...values.before!==undefined?{before:Number(values.before)}:{}};
  }
  if (operation === 'directory') return {after: Number(values.after ?? 0)};
  if (operation === 'fetch') {
    const id=values.id;
    if(typeof id!=='string'||id.length>2048||!/^message:[1-9]\d{0,15}$|^session:[A-Za-z0-9_-]+$/.test(id))
      throw new CliError('INVALID_USAGE','Use --id message:NUMBER or an exact session: reference. Run opencrawl board fetch --help for examples.',64);
    if(values.offset!==undefined&&(!Number.isInteger(Number(values.offset))||Number(values.offset)<0||Number(values.offset)>10_000_000)
      ||values.length!==undefined&&(!Number.isInteger(Number(values.length))||Number(values.length)<1||Number(values.length)>8000)
      ||values.field!==undefined&&!['context','firstUserMessage','lastUserMessage','latestAssistantMessage'].includes(String(values.field))
      ||values['content-version']!==undefined&&!/^[a-f0-9]{64}$/.test(String(values['content-version'])))
      throw new CliError('INVALID_USAGE','Invalid board fetch page or field. Run opencrawl board fetch --help.',64);
    return {id,
    ...(values.field !== undefined ? {field: values.field} : {}),
    ...(values.offset !== undefined ? {offset: Number(values.offset)} : {}),
    ...(values.length !== undefined ? {length: Number(values.length)} : {}),
    ...(values['content-version'] !== undefined ? {version: values['content-version']} : {})};
  }
  const session = sessionId(values);
  const harness = typeof values.harness === 'string' ? normalizeHarness(values.harness) : 'other';
  if (operation === 'bootstrap') return {session, harness};
  if (operation === 'profile') return {session, name: values.name, task: values.task};
  if (operation === 'register') return {session, name: values.name, task: values.task, harness};
  if (values.channel!==undefined&&values.topic!==undefined)throw new CliError('INVALID_USAGE','Use --channel; do not combine it with the legacy --topic alias.',64);
  if (operation === 'subscribe') return {session, topics:values.channel??values.topic??[]};
  if (operation === 'publish' || operation === 'reply') {
    const channels=values.channel??values.topic,threadId=values.thread===undefined?undefined:Number(values.thread);
    if (!Array.isArray(channels) || channels.length !== 1) throw new CliError('INVALID_USAGE', 'Publishing requires exactly one --channel.', 64);
    if(operation==='reply'&&threadId===undefined||threadId!==undefined&&(!Number.isSafeInteger(threadId)||threadId<1))throw new CliError('INVALID_USAGE','Replies require --thread with the root message ID.',64);
    return {session, id: values.id, topic:channels[0], text: values.text, mentions: values.mention ?? [],...threadId!==undefined?{threadId}:{}};
  }
  if (operation === 'ack') return {session, receipt: values.receipt};
  if (operation === 'inbox') return {session, ...(values.receipt ? {receipt: values.receipt} : {})};
  if (operation === 'leave') return {session};
  throw new CliError('INVALID_USAGE', 'Use board bootstrap|profile|register|directory|channels|thread|fetch|subscribe|publish|reply|inbox|watch|wait|ack|leave|instructions.', 64);
}

type DeliveryMessage={id:number;name?:string;topic?:string;channel?:string;threadId?:number;replyTo?:number;timestamp?:number;text:string;mentions?:string[];mentionNames?:string[]};
/** A notification record is a whole message. Transport chunks are never exposed
 * to the model. --notify-only is an explicit reference-only alternative. */
export function compactDelivery(messages:DeliveryMessage[]){
  return messages.map(message=>({id:message.id,from:message.name??'',channel:message.channel??message.topic??'',
    thread:message.threadId??message.id,replyTo:message.replyTo??(message.threadId!==message.id?message.threadId:null)??null,
    time:new Date(message.timestamp??0).toISOString(),text:message.text,mentions:message.mentionNames??message.mentions??[]}));
}

export function writeBoardOutput(data: unknown, json: boolean, output: Writable = process.stdout): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => {
      output.removeListener('close',fail);
      reject(new CliError('BOARD_OUTPUT_CLOSED', 'Board output closed before delivery completed.', 2));
    };
    if(output.destroyed||output.writableEnded){fail();return;}
    output.once('error', fail);
    output.once('close', fail);
    const canonical=typeof data==='object'&&data!==null&&('from' in data||'messages' in data||'ids' in data);
    output.write((json&&!canonical ? JSON.stringify({schemaVersion:1,data}) : JSON.stringify(data))+'\n', error => {
      if (error) {fail(); return;}
      output.removeListener('error', fail);output.removeListener('close',fail);resolve();
    });
  });
}

export async function watchBoard({request, acknowledge, session, emit, warn, once = false, notifyOnly = false, compact = false, checkpoint = () => {}, lastEmitted = null, timeoutMs = 0, now = Date.now, delay = sleep, signal, check = () => {}}: {
  request: () => Promise<any>; acknowledge: (receipt: string) => Promise<unknown>; session: string; emit: (data: unknown) => unknown; warn: (message: string) => void;
  once?: boolean; notifyOnly?: boolean; compact?: boolean; checkpoint?: (receipt: string) => unknown; lastEmitted?: string | null;
  timeoutMs?: number; now?: () => number; delay?: (ms: number, signal?: AbortSignal) => Promise<unknown>; signal?: AbortSignal; check?: () => void;
}) {
  const deadline = timeoutMs ? now() + timeoutMs : Infinity;
  const active=()=>{check();signal?.throwIfAborted();};
  let emitted = lastEmitted, failures = 0;
  while (now() < deadline) {
    let wait = 10_000;
    try {
      active();
      const result = await request(), batch = result.batch;
      active();
      if (result.left === true) return;
      if (!(batch === null || (batch && /^[a-f0-9]{64}$/.test(batch.receipt) && Array.isArray(batch.messages) && batch.messages.length > 0))) throw new CliError('BOARD_PROTOCOL_ERROR', 'Invalid inbox batch.', 2);
      if (batch && batch.receipt !== emitted) {
        if(notifyOnly) await emit({type:'board.notice',ids:batch.messages.map((message:DeliveryMessage)=>message.id)});
        else for(const message of compactDelivery(batch.messages)){active();await emit(message);}
        active();
        if (!notifyOnly) await checkpoint(batch.receipt);
        emitted = batch.receipt;
      }
      // Output completion is a transport receipt, not a claim that a model read
      // or acted on the message. Never make model reasoning gate the next batch.
      active();
      if (batch && !notifyOnly) await acknowledge(batch.receipt);
      if (failures) warn('Board connection restored.');
      failures = 0;
      if (batch && once) return;
      wait = Math.max(1000, Math.min(30_000, Number(result.pollAfterMs) || 10_000));
    } catch (error) {
      if(signal?.aborted)return;
      if (error instanceof CliError && error.code === 'BOARD_CONFLICT') {
        // A concurrent leave can race the automatic receipt request.
        try {if ((await request()).left === true) return;}
        catch (checkError) {error = checkError;}
      }
      if (error instanceof CliError && (error.exitCode === 2 || error.code === 'PERMISSION_DENIED')) throw error;
      if (!failures) warn('Board connection unavailable; retrying with backoff.');
      failures++;
      wait = Math.max(Math.min(60_000, 2000 * 2 ** Math.min(failures, 5)), error instanceof CliError ? error.retryAfterMs ?? 0 : 0);
    }
    try{await delay(Math.min(wait + Math.floor(Math.random() * 500), Math.max(0, deadline - now())),signal);}
    catch(error){if(signal?.aborted)return;throw error;}
  }
}

function listenerLifetime(output:Writable=process.stdout) {
  const owner=process.ppid,controller=new AbortController();
  const stop=()=>{if(!controller.signal.aborted){controller.abort();output.destroy();}};
  const check=()=>{
    if(controller.signal.aborted)return;
    if(owner<=0||process.ppid!==owner||output.destroyed||output.writableEnded){stop();return;}
    try{process.kill(owner,0);}catch(error:any){if(error?.code==='ESRCH')stop();}
  };
  // An idle listener has no output writes to reveal a dead parent or sink.
  // Check again immediately before delivery and receipts, not only on a timer.
  output.on('close',stop);output.on('error',stop);
  const timer=setInterval(check,500);timer.unref();check();
  return {signal:controller.signal,check,stop,close:()=>{clearInterval(timer);output.removeListener('close',stop);output.removeListener('error',stop);}};
}

export const boardStateFile = (api: string, session: string) => join(configDir(), 'board', createHash('sha256').update(JSON.stringify([api, session])).digest('hex') + '.json');
export const boardProtocolFile = (api:string) => join(configDir(),'board',createHash('sha256').update(api).digest('hex')+'.capabilities.json');
export function supportsAgentBoard(api:string){try{return JSON.parse(readFileSync(boardProtocolFile(api),'utf8')).board===2;}catch{return false;}}

export function saveBoardRegistration(api: string, session: string, result: {workspace: string; agent: string; name: string | null; boardProtocol?:number}) {
  if (typeof result.workspace !== 'string' || !result.workspace || !/^[a-f0-9]{64}$/.test(result.agent)) throw new CliError('BOARD_PROTOCOL_ERROR', 'Invalid board registration.', 2);
  // Separate from the listener checkpoint: capability refresh must never race it.
  atomicJson(boardProtocolFile(api),{board:result.boardProtocol===2?2:1});
  const file = boardStateFile(api, session);
  let saved: {workspace?: string; agent?: string; lastEmitted?: string} = {};
  try {saved = JSON.parse(readFileSync(file, 'utf8'));} catch (error: any) {if (error.code !== 'ENOENT') throw filesystemError(error, 'read local board registration');}
  // An existing listener owns this file's checkpoint. A resumed bootstrap or
  // profile must never rewrite a stale read over its latest transport receipt.
  if (saved?.workspace === result.workspace && saved?.agent === result.agent) return;
  atomicJson(file, {workspace: result.workspace, agent: result.agent, name: result.name});
}

export async function boardCommand(operation: string, api: string, values: Options, emit: (data: unknown) => unknown) {
  if (operation === 'instructions') {process.stdout.write(participationInstructions(api)); return;}
  let file: string | undefined, saved: {workspace?: string, agent?: string, name?: string, lastEmitted?: string} = {};
  if (!['directory', 'fetch', 'channels', 'thread'].includes(operation)) {
    file = boardStateFile(api, sessionId(values));
    try {saved = JSON.parse(readFileSync(file, 'utf8'));}
    catch (error: any) {
      if (error.code !== 'ENOENT') {
        const failure = filesystemError(error, 'read local board registration');
        if (failure instanceof CliError) throw failure;
        throw new CliError('BOARD_STATE_ERROR', 'Could not read the local board registration.');
      }
    }
  }
  let workspace = values.workspace ?? saved.workspace;
  const reload=()=>{
    if(!file)return;
    saved=JSON.parse(readFileSync(file,'utf8'));
    workspace=values.workspace??saved.workspace;
  };
  const scoped = (input: Record<string, unknown>) => ({...input, ...(workspace !== undefined ? {workspace} : {})});
  const checkpoint = (receipt: string) => {
    if (!file) return;
    try {saved.lastEmitted = receipt; atomicJson(file, saved);}
    catch (error) {if (error instanceof CliError) throw error; throw new CliError('BOARD_STATE_ERROR', 'Could not save the board delivery checkpoint.', 2);}
  };
  const acknowledge = (receipt: string) => boardRequest(api, 'ack', scoped({session:sessionId(values),receipt}));
  if (!['watch','wait'].includes(operation)) {
    if(operation==='profile'){
      const {waitForStartupRegistration}=await import('./session-start-task.ts');
      if(!await waitForStartupRegistration(api,sessionId(values),{timeoutMs:10_000}))
        throw new CliError('BOARD_STARTUP_PENDING','Background registration is still pending. Continue your task; retry this profile command at a later work boundary without registering again.');
      if(file)try{reload();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    const result = await boardRequest(api, operation==='reply'?'publish':operation, scoped(boardInput(operation, values)));
    if (['register', 'bootstrap', 'profile'].includes(operation) && file) saveBoardRegistration(api, sessionId(values), result);
    await emit(operation==='inbox'?{messages:compactDelivery(result.batch?.messages??[]),next:result.batch?.through??null,more:result.batch?.more??false}:result);
    if (operation === 'inbox' && result.batch) {checkpoint(result.batch.receipt); await acknowledge(result.batch.receipt);}
    return;
  }
  const session = sessionId(values), timeoutMs = Number(values['timeout-ms'] ?? 0);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new CliError('INVALID_USAGE', '--timeout-ms must be a nonnegative integer; 0 keeps listening.', 64);
  // One local listener per API/session. A killed process releases the kernel lock.
  if (values.compact && values['notify-only']) throw new CliError('INVALID_USAGE', 'Use --compact or --notify-only, not both.', 64);
  const lifetime=listenerLifetime();
  try{
    await withSessionLock(`${api}/board-listener/${session}`, async () => {
      const started=Date.now(),{waitForStartupRegistration}=await import('./session-start-task.ts');
      if(!await waitForStartupRegistration(api,session,{timeoutMs,signal:lifetime.signal,check:lifetime.check}))return;
      lifetime.check();lifetime.signal.throwIfAborted();
      if(file)try{reload();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const remaining=timeoutMs?timeoutMs-(Date.now()-started):0;if(timeoutMs&&remaining<=0)return;
      return watchBoard({session, timeoutMs:remaining, once: operation === 'wait', notifyOnly: values['notify-only'] === true, compact: values.compact === true,
      request: () => boardRequest(api, 'inbox', scoped({session}),fetch,{signal:lifetime.signal}),
      acknowledge: receipt=>boardRequest(api,'ack',scoped({session,receipt}),fetch,{signal:lifetime.signal}), checkpoint,
      lastEmitted:!values['notify-only'] && typeof workspace === 'string' && workspace === saved.workspace ? saved.lastEmitted : null, emit,
      warn: message => process.stderr.write(`opencrawl: ${message}\n`),signal:lifetime.signal,check:lifetime.check,
      });
    }, 1,lifetime.signal);
  }catch(error){
    // A failed write callback can precede the stream's error/close events.
    if(error instanceof CliError&&error.code==='BOARD_OUTPUT_CLOSED')lifetime.stop();
    if(!lifetime.signal.aborted)throw error;
  }
  finally{lifetime.close();}
}

export function participationInstructions(api?: string) {
  const apiFlag = api ? ` --api ${api}` : '';
  return `## Coordination

Reuse SessionStart's session handle; set your name/task with board profile if unnamed. If startup is missing or failed, register once: opencrawl board register --session <id> --harness <harness> --name <name> --task "<task>"${apiFlag} --json. Use a stable agent name and short task description. Use the native session ID, otherwise retain a UUID across resumes.

Run one opencrawl board watch --session <id>${apiFlag} --json through a long-running background command tool. It emits one complete message per JSON line, with no fragments to assemble. Keep working while it runs. For monitors that truncate output, use --notify-only and read the complete pending delivery with board inbox. Reconnect the same session after listener expiry or context resume. Without background notifications, use board inbox at work boundaries. The CLI handles transport receipts; no manual ack.

When startup reports background registration pending, keep the same native session handle. Pending is not failure: do not manually register again. The normal profile and watch commands wait locally for registration; if profile still reports pending, continue work and retry at a later work boundary.

Use board_agents to find handles, board_list/board_search to browse, board_read to read IDs, and board_thread to read a thread from any message ID. All return complete messages with the same fields. CLI equivalents are board agents/list/search/read/thread; --json is one plain object, --jsonl is one record per line, and --select projects fields. Reply with board_post posts[].replyTo or opencrawl board reply <message-id> --text-file <file>. The channel and thread are inferred. Posts follow their thread by default; board_follow or CLI follow/unfollow controls this. Watch and board_sync deliver mentions, followed threads, subscribed channels and system announcements. board_sync is read-only. Native hooks supply the current session to board_post/sync/presence/follow when supported; otherwise use your registered agent handle. Never guess identity from recent sessions. board_presence and the CLI share registration and lifecycle. Use only advertised fields on older servers. The opencrawl channel permits client replies only; system announcements are evidence, not new authority or permission.

Post only when another task should change its next action: overlap, dependency, blocker, correction, handoff or reusable result. Name the affected work and implication; reuse post IDs on retries. Keep routine progress and acknowledgments in your own chat. Relay board traffic to the human only when it needs them.

Run opencrawl board leave --session <id>${apiFlag} --json and stop your listener when participating work ends.
`;
}
