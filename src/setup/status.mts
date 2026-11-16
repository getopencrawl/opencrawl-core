import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {sessionScope} from '../sessions/ingest.mjs';
import {isSessionHarness} from '../sessions/types.mjs';
import type {Principal,SessionBatch,SessionEvent} from '../sessions/types.mjs';
import type {createWorkspaceSearch} from '../search/workspace.mjs';
import {SETUP_CLIENTS,SETUP_PLUGIN_STATES} from './types.mjs';
import type {SetupStatus,SetupClientStatus,SetupProof,SetupHumanTask} from './types.mjs';

const identifier=z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
export const setupInstallationSchema=z.strictObject({installationId:identifier,machine:z.strictObject({id:identifier,label:z.string().trim().min(1).max(100)}),clients:z.array(z.strictObject({
  client:z.enum(SETUP_CLIENTS),installed:z.boolean(),pluginState:z.enum(SETUP_PLUGIN_STATES).optional(),forward:z.boolean(),history:z.enum(['skip','import']),
  historyProgress:z.strictObject({state:z.enum(['not_started','running','complete','failed']),completed:z.number().int().nonnegative(),total:z.number().int().nonnegative().optional(),error:z.string().max(240).optional()}),
  hookTrust:z.enum(['unknown','pending','trusted','not_required']),
})).min(1).max(SETUP_CLIENTS.length)}).refine(value=>new Set(value.clients.map(c=>c.client)).size===value.clients.length,'Duplicate clients');
export const setupVerifySchema=z.strictObject({installationId:identifier,client:z.enum(SETUP_CLIENTS)});
export const setupMcpVerifySchema=setupVerifySchema.extend({proofId:z.string().regex(/^[a-f0-9]{32}$/)});
type Selection=z.infer<typeof setupVerifySchema>;
import type {ApplicationState} from '../state/types.mjs';
import {validateSetupState,type SetupEvidence as Evidence,type SetupStoredClient as StoredClient,type SetupStateRecord as StoredStatus} from './state.mjs';
function fail(status:number,message:string):never {throw Object.assign(new Error(message),{status,expose:true});}
const token=()=>randomBytes(16).toString('hex');
const instant=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
function conversationText(event:SessionEvent):string {
  const content=event.data?.content;
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return '';
  // Claude wraps tool results in user-role messages. A CLI response containing
  // our marker is tool output, not the requested native conversational event.
  return content.flatMap(block=>block&&typeof block==='object'&&['text','input_text','output_text'].includes(String(block.type))&&typeof block.text==='string'?[block.text]:[]).join('\n');
}
function toolBlocks(event:SessionEvent):Record<string,unknown>[] {
  const data=event.data??{},content=Array.isArray(data.content)?data.content:[];
  return [...(['tool_call','tool_result'].includes(event.kind)?[data]:[]),...content.filter((block):block is Record<string,unknown>=>Boolean(block)&&typeof block==='object'&&!Array.isArray(block))];
}
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const failedNativeResult=(block:Record<string,unknown>)=>block.is_error===true||block.isError===true||
  object(block.output)&&Array.isArray(block.output.content)&&block.output.isError===true;
function agyValue(value:unknown):unknown {
  // Compact native records JSON-encode individual wrapper arguments. Proof
  // inputs are small; never recursively decode arbitrary tool output.
  if(typeof value!=='string'||value.length>8192)return value;
  try{return JSON.parse(value);}catch{return value;}
}
function verificationBlocks(batch:SessionBatch,event:SessionEvent,proofId:string):Record<string,unknown>[] {
  if(batch.harness==='cursor') {
    const data=event.data??{},id=callId(data,true),output=data.output;
    // Cursor's completed MCP hook omits the server namespace. Its collector
    // retains both halves together with one native ID and adjacent sequences.
    // Admit that completed pair only; neither an input-only transcript record
    // nor a failed completion may donate evidence to another event.
    if(event.kind!=='tool_result'||data.type!=='tool_result'||data.name!=='MCP:verify_installation'||failedNativeResult(data)||
      !id||!id.trim()||event.nativeId!==id||!Number.isSafeInteger(event.sequence)||Number(event.sequence)<1||!object(output)||!Array.isArray(output.content))return [];
    const calls=batch.events.filter(candidate=>candidate.kind==='tool_call'&&candidate.data?.type==='tool_use'&&
      candidate.data.name===data.name&&callId(candidate.data)===id&&candidate.nativeId===id&&
      Number.isSafeInteger(candidate.sequence)&&Number(candidate.sequence)+1===event.sequence&&candidate.timestamp===event.timestamp);
    if(calls.length!==1||failedNativeResult(calls[0]!.data!))return [];
    const call={id,name:'verify_installation',input:calls[0]!.data!.input};
    if(!nativeVerificationCall(call,proofId,batch.installationId,batch.harness))return [];
    return [call,{type:'tool_result',call_id:id,output}];
  }
  if(batch.harness==='codex'&&event.kind==='mcp_tool_call_end') {
    const data=event.data??{},item=data.item;
    // Codex code mode records the actual MCP exchange in item_completed. Never
    // infer a native invocation from JavaScript source or the outer exec output.
    if(data.type!=='item_completed'||data.thread_id!==batch.sessionId||!object(item)||item.type!=='McpToolCall'||item.status!=='completed'||item.error||item.isError||
      typeof item.server!=='string'||!/^opencrawl(?:-[a-f0-9]{12})?$/.test(item.server)||item.tool!=='verify_installation'||
      !object(item.arguments)||!object(item.result)||item.result.isError||item.result.error||typeof item.id!=='string'||!item.id.trim()||!callId(item))return [];
    const call={id:item.id,name:item.server+'/'+item.tool,input:item.arguments};
    // Both halves belong to this one completed native record. A mismatched
    // invocation must not leave a result that can pair with a later call.
    if(!nativeVerificationCall(call,proofId,batch.installationId,batch.harness))return [];
    return [call,{type:'tool_result',call_id:item.id,output:item.result}];
  }
  if(batch.harness!=='antigravity')return toolBlocks(event);
  const data=event.data??{};
  // Antigravity's documented PostToolUse stepIdx identifies the completed
  // native step. The collector retains that hook and the GENERIC result's
  // matching sequence/nativeId; neither contains a native tool call ID.
  if(event.kind==='hook'&&data.hookEventName==='PostToolUse'&&!data.error&&data.conversationId===batch.sessionId&&Number.isSafeInteger(data.stepIdx)&&Number(data.stepIdx)>=0){
    const tool=data.toolCall;if(!object(tool)||tool.name!=='call_mcp_tool')return [];
    const args=agyValue(tool.args);if(!object(args))return [];
    const server=agyValue(args.ServerName),name=agyValue(args.ToolName),input=agyValue(args.Arguments);
    if(typeof server!=='string'||!/^opencrawl(?:-[a-f0-9]{12})?(?:_opencrawl)?$/.test(server)||name!=='verify_installation'||!object(input))return [];
    return [{id:'antigravity-step:'+data.stepIdx,name,input}];
  }
  if(event.kind==='tool_result'&&data.type==='tool_result'&&!data.is_error&&Number.isSafeInteger(event.sequence)&&Number(event.sequence)>=0&&event.nativeId===String(event.sequence)){
    return [{...data,call_id:'antigravity-step:'+event.sequence}];
  }
  return [];
}
const callId=(block:Record<string,unknown>,result=false)=>{
  const value=result?(block.call_id??block.tool_use_id):(block.call_id??block.id);
  return typeof value==='string'&&value.length>0&&value.length<=200?value:null;
};
function nativeVerificationCall(block:Record<string,unknown>,proofId:string,installationId:string,client:string) {
  if(typeof block.name!=='string'||!(block.name==='verify_installation'||block.name.includes('opencrawl')&&/(?:__|[./:])verify_installation$/.test(block.name)))return false;
  let input=block.arguments??block.input;
  if(typeof input==='string')try{input=JSON.parse(input);}catch{return false;}
  if(!input||typeof input!=='object')return false;
  const fields=input as Record<string,unknown>;
  return fields.proofId===proofId&&fields.installationId===installationId&&fields.client===client;
}

/** Scoped product evidence, not an authorization grant or a claim that every client works.
 * Configuration and history receipts cannot satisfy native capture/search proof.
 * Compare-and-set preserves simultaneous CLI progress and capture/MCP observations.
 */
export function createSetupStatus({state,search,now=()=>new Date()}: {
  state:Pick<ApplicationState,'setup'>;
  search:Pick<ReturnType<typeof createWorkspaceSearch>,'search'|'fetch'>;now?:()=>Date;
}) {
  function admit(principal:Principal) {sessionScope(principal);if(principal.captureAccess!==undefined)fail(403,'Capture credentials cannot manage setup.');}
  async function load(principal:Principal) {
    const stored=await state.setup.read(principal);
    const data:StoredStatus=stored.record?validateSetupState(stored.record,principal):{schemaVersion:1,scope:{tenantId:principal.tenantId,userId:principal.userId},firstWin:null,installations:[]};
    return {version:stored.version,data};
  }
  async function update<T>(principal:Principal,apply:(data:StoredStatus)=>T):Promise<T> {
    for(let attempt=0;attempt<8;attempt++) {
      const {version,data}=await load(principal),result=apply(data);
      const bytes=Buffer.from(JSON.stringify(data));
      if(bytes.length>256*1024)fail(409,'Setup status limit reached. Remove unused local observations before adding more.');
      if(await state.setup.save(principal,version,data))return result;
    }
    fail(409,'Setup changed concurrently. Retry this operation.');
  }
  function selected(data:StoredStatus,input:Selection) {
    const installation=data.installations.find(i=>i.installationId===input.installationId);
    const client=installation?.clients.find(c=>c.client===input.client);
    if(!installation||!client)fail(404,'Register this installation and client before verifying.');
    return {installation,client};
  }
  function publicClient(client:StoredClient):SetupClientStatus {
    const {evidence,...observation}=client;
    const proof:SetupProof=evidence?{...evidence.proof}:{state:client.forward?'pending':'not_selected'};
    if(!['verified','not_selected'].includes(proof.state)&&proof.expiresAt&&instant(proof.expiresAt)<now().getTime())proof.state='expired';
    const boundMcp=evidence?.mcpCall&&evidence.mcpNative&&evidence.capture?.sessionId===evidence.mcpNative.sessionId;
    const mcp:SetupClientStatus['mcp']=boundMcp?{state:'authenticated',observedAt:evidence.mcpNative!.observedAt}:evidence?.mcpCall?{state:'observed',observedAt:evidence.mcpCall.issuedAt}:{state:'pending'};
    const humanTasks:SetupHumanTask[]=[];
    if(client.forward&&!evidence?.capture&&['unknown','pending'].includes(client.hookTrust))humanTasks.push({id:client.client+':hook-trust',kind:'hook_trust',client:client.client,title:'Approve this client’s hooks',instruction:'Open this client’s own trust controls and approve the installed OpenCrawl hooks. The CLI cannot approve trust on your behalf.'});
    if(client.installed&&mcp.state==='pending')humanTasks.push({id:client.client+':mcp-auth',kind:'mcp_auth',client:client.client,title:'Connect this client to OpenCrawl',instruction:client.client==='devin'?'In this Devin Cloud session, use the installed plugin’s native MCP tools with its renewable workload identity and call verify_installation with this installationId, client and proofId. Repair the provider helper or organization connection if tools are unavailable; do not copy a human token or start interactive login.':'In this client, finish its OpenCrawl MCP sign-in, then call verify_installation with this installationId, client and proofId. Leave other clients pending until they run their own check.'});
    if(proof.state==='waiting_capture'&&proof.marker)humanTasks.push({id:client.client+':native-event',kind:'native_event',client:client.client,title:'Record one new native message',instruction:`In this client’s current native conversation, include ${proof.marker} in a normal assistant message, then let its installed capture hooks run. Do not write a synthetic transcript or upload a test batch.`});
    return {...observation,...(evidence?.capture?{captureObservedAt:evidence.capture.observedAt}:{}),mcp,proof,humanTasks};
  }
  const view=(data:StoredStatus):SetupStatus=>({...data,pluginStateSupported:true,installations:data.installations.map(i=>({...i,clients:i.clients.map(publicClient)}))});
  function fresh(event:SessionEvent,since:string) {
    const time=instant(event.timestamp);return Number.isFinite(time)&&time>=instant(since)&&time<=now().getTime()+60_000;
  }
  function matches(hit:unknown,principal:Principal,input:Selection,evidence:Evidence):hit is {id:string;text:string;provenance:Record<string,unknown>} {
    if(!hit||typeof hit!=='object')return false;
    const h=hit as {id?:unknown;text?:unknown;source?:unknown;provenance?:Record<string,unknown>},p=h.provenance;
    return h.source==='sessions'&&typeof h.id==='string'&&typeof h.text==='string'&&h.text.includes(evidence.proof.marker!)&&
      p?.userId===principal.userId&&p.installationId===input.installationId&&p.harness===input.client&&p.sessionId===evidence.capture?.sessionId&&p.eventId===evidence.capture?.eventId;
  }
  return {
    async read(principal:Principal) {admit(principal);return view((await load(principal)).data);},
    async installation(principal:Principal,input:unknown) {
      admit(principal);const parsed=setupInstallationSchema.safeParse(input);if(!parsed.success)fail(400,'Invalid installation observations. Scope, proof and MCP evidence are server-owned.');
      return update(principal,data=>{
        let installation=data.installations.find(i=>i.installationId===parsed.data.installationId);
        if(!installation) {if(data.installations.length>=32)fail(409,'Installation limit reached.');installation={installationId:parsed.data.installationId,machine:parsed.data.machine,updatedAt:now().toISOString(),clients:[]};data.installations.push(installation);}
        if(installation.machine.id!==parsed.data.machine.id)fail(409,'Installation belongs to a different machine. Use its original identity.');
        installation.machine=parsed.data.machine;installation.updatedAt=now().toISOString();
        for(const observed of parsed.data.clients) {
          const prior=installation.clients.find(c=>c.client===observed.client);
          const forwardSince=observed.forward?(prior?.forwardSince&&prior.forward?prior.forwardSince:now().toISOString()):undefined;
          // installed reports plugin files, not authentication or capture consent.
          // Plugin choice is independent of future capture and historical import.
          const next:StoredClient={...observed,...(forwardSince?{forwardSince}:{}),...(prior?.evidence&&prior.forward===observed.forward?{evidence:prior.evidence}:{})};
          if(prior)installation.clients[installation.clients.indexOf(prior)]=next;else installation.clients.push(next);
        }
        return view(data);
      });
    },
    /** Called only after the immutable batch and durable indexing handoff commit. */
    async session(principal:Principal,batch:SessionBatch) {
      sessionScope(principal);
      if(batch.owner?.tenantId!==principal.tenantId||batch.owner?.userId!==principal.userId)fail(403,'Capture owner mismatch');
      // Origin is descriptive collector metadata (parse.detectOrigin can return
      // unknown for native sessions). It grants no authority: authenticated owner,
      // selected installation/harness, live mode, boundary and nonce remain required.
      if(batch.captureMode!=='live'||!isSessionHarness(batch.harness)||!['cli','desktop','cloud','unknown'].includes(batch.origin))return;
      const existing=(await load(principal)).data.installations.find(i=>i.installationId===batch.installationId)?.clients.find(c=>c.client===batch.harness);
      if(!existing?.forward||!existing.evidence)return;
      await update(principal,data=>{
        const client=data.installations.find(i=>i.installationId===batch.installationId)?.clients.find(c=>c.client===batch.harness),e=client?.evidence;
        if(!client?.forward||!client.forwardSince||!e||e.proof.state!=='verified'&&instant(e.proof.expiresAt)<now().getTime())return;
        const since=instant(client.forwardSince)>instant(e.proof.issuedAt)?client.forwardSince:e.proof.issuedAt!;
        const message=batch.events.find(event=>event.kind==='message'&&fresh(event,since)&&['user','assistant'].includes(String(event.data?.role))&&conversationText(event).includes(e.proof.marker!));
        if(message&&!e.capture) {e.capture={sessionId:batch.sessionId,eventId:message.id,timestamp:message.timestamp!,observedAt:now().toISOString()};e.proof={...e.proof,state:'waiting_index',sessionId:batch.sessionId,eventId:message.id};}
        // Claude embeds native tool_use/tool_result blocks inside messages;
        // Codex records separate call/result events. A terminal command returning
        // an MCP response is not a native MCP invocation and must not pass.
        for(const event of batch.events)for(const block of verificationBlocks(batch,event,e.proof.id!)) {
          const id=callId(block);
          // AGY hooks observe completion after the server issues its receipt;
          // its result created_at may instead describe the step's start. Bind
          // the completed hook after receipt issuance and its exact result
          // after challenge issuance. Other clients retain their native IDs.
          const callSince=batch.harness==='antigravity'?e.mcpCall?.issuedAt:since;
          if(id&&callSince&&fresh(event,callSince)&&nativeVerificationCall(block,e.proof.id!,batch.installationId,batch.harness)) {
            e.nativeCalls=[...(e.nativeCalls??[]).filter(call=>call.callId!==id||call.sessionId!==batch.sessionId),{callId:id,sessionId:batch.sessionId}].slice(-8);
          }
          const resultId=callId(block,true);
          if(resultId&&e.mcpCall&&!failedNativeResult(block)&&(event.kind==='tool_result'||block.type==='tool_result')&&fresh(event,batch.harness==='antigravity'?since:e.mcpCall.issuedAt)&&JSON.stringify(block).includes(e.mcpCall.receipt)) {
            e.nativeResults=[...(e.nativeResults??[]).filter(result=>result.callId!==resultId||result.sessionId!==batch.sessionId),{callId:resultId,sessionId:batch.sessionId,eventId:event.id,observedAt:now().toISOString()}].slice(-8);
          }
        }
        const native=e.nativeResults?.find(result=>e.nativeCalls?.some(call=>call.callId===result.callId&&call.sessionId===result.sessionId)&&(!e.capture||e.capture.sessionId===result.sessionId));
        if(native)e.mcpNative={sessionId:native.sessionId,eventId:native.eventId,observedAt:native.observedAt};
      });
    },
    async verify(principal:Principal,input:unknown):Promise<SetupClientStatus> {
      admit(principal);const parsed=setupVerifySchema.safeParse(input);if(!parsed.success)fail(400,'Choose one installation and client.');
      const selection=parsed.data;
      await update(principal,data=>{
        const {client}=selected(data,selection);
        // A plugin is optional distribution. Verification still requires this
        // authenticated user's registered client and the actual proof below.
        if(!client.evidence||client.evidence.proof.state!=='verified'&&instant(client.evidence.proof.expiresAt)<now().getTime()) {
          const id=token(),capturing=client.forward&&isSessionHarness(client.client);client.evidence={proof:{state:capturing?'waiting_capture':'not_selected',id,...(capturing?{marker:'opencrawlverify'+id}:{}),issuedAt:now().toISOString(),expiresAt:new Date(now().getTime()+60*60_000).toISOString()}};
        }
      });
      const initial=selected((await load(principal)).data,selection).client,evidence=initial.evidence;
      if(!evidence?.capture)return publicClient(initial);
      // These are the same authorized read operations used by native agents and CLI.
      // Exact provenance binds the result to this user, installation, harness and event.
      // A workload principal can infer the current session; this proof must include it.
      const result=await search.search(principal,{query:evidence.proof.marker,source:'sessions',match:'all',sessionId:evidence.capture.sessionId,includeCurrentSession:true,filters:{authors:[principal.userId],harnesses:[selection.client]},limit:40,groupBy:'none',dedupe:false,select:['text','provenance'],excerptChars:2000});
      const hit=result.results.find(row=>matches(row,principal,selection,evidence));
      let passageId:string|undefined;
      if(hit&&typeof hit.id==='string') {
        const fetched=await search.fetch(principal,{id:hit.id,offset:typeof hit.excerpt==='object'&&hit.excerpt&&'start' in hit.excerpt?hit.excerpt.start:0,length:6000});
        if(matches(fetched,principal,selection,evidence))passageId=hit.id;
      }
      return update(principal,data=>{
        const {client}=selected(data,selection);
        const current=client.evidence;
        if(!current||current.proof.id!==evidence.proof.id)fail(409,'Verification changed. Retry this client.');
        current.proof={...current.proof,state:passageId?'verified':'waiting_index',...(passageId?{passageId,verifiedAt:now().toISOString()}:{verifiedAt:undefined,passageId:undefined})};
        if(passageId&&!data.firstWin)data.firstWin={installationId:selection.installationId,client:selection.client,verifiedAt:now().toISOString()};
        return publicClient(client);
      });
    },
    /** Only the authenticated MCP transport calls this. The secret result nonce is
     * absent from status/CLI responses; native capture must observe the result in
     * the selected client before its MCP status becomes authenticated. */
    async mcp(principal:Principal,input:unknown) {
      admit(principal);const parsed=setupMcpVerifySchema.safeParse(input);if(!parsed.success)fail(400,'Use this client’s current installation and proofId.');
      const selection=parsed.data;
      const result=await update(principal,data=>{
        const {client}=selected(data,selection),e=client.evidence;
        if(!e||e.proof.id!==selection.proofId||e.proof.state!=='verified'&&instant(e.proof.expiresAt)<now().getTime())fail(409,'Proof is missing or expired. Run verify-installation for this client.');
        e.mcpCall??={receipt:'opencrawlmcp'+token(),issuedAt:now().toISOString()};
        return {receipt:e.mcpCall.receipt,capturing:client.forward&&isSessionHarness(client.client)};
      });
      return {proofId:selection.proofId,receipt:result.receipt,status:result.capturing?'awaiting_native_capture':'authenticated_transport_observed',instruction:result.capturing?'Let this client’s native capture record this tool result, then run verify-installation again. This call alone does not verify capture or search.':'The authenticated MCP call was observed. Forward capture was not selected; no native capture proof is claimed or required for search-only use.'};
    },
  };
}
