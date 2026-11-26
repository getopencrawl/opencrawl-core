type UsageRange=import('../../../src/application/usage-range.mjs').UsageRange;
import {createTRPCClient, httpLink, type TRPCClient} from '@trpc/client';
import type {ProductRouter} from '../../../dist/src/application/rpc.mjs';
import type {LibraryAdapter, LibraryContract, LibraryOperation} from '../../../src/application/library-types.mjs';
import type {WorkspaceRole} from './api.ts';
import {rpcTransportOptions, rpcRead as read, rpcWrite as write} from './transport.ts';
export function createProductApi(webRpc: TRPCClient<ProductRouter> = createTRPCClient<ProductRouter>({links: [httpLink(rpcTransportOptions())]})) {
const libraryOperations: {[O in LibraryOperation]: (input: LibraryContract[O]['input'], signal: AbortSignal) => Promise<LibraryContract[O]['output']>} = {
  'privacy/status':(input,signal)=>read(()=>webRpc.library.privacy.status.query(input,{signal}),signal),
  'privacy/change':(input,signal)=>write(()=>webRpc.library.privacy.change.mutate(input,{signal}),signal),
  'recording/status':(input,signal)=>read(()=>webRpc.library.recording.status.query(input,{signal}),signal),
  'recording/change':(input,signal)=>write(()=>webRpc.library.recording.change.mutate(input,{signal}),signal),
  'sessions/list':(input,signal)=>read(()=>webRpc.library.sessions.list.query(input,{signal}),signal),
  'sessions/read':(input,signal)=>read(()=>webRpc.library.sessions.read.query(input,{signal}),signal),
  'sessions/visibility':(input,signal)=>write(()=>webRpc.library.sessions.visibility.mutate(input,{signal}),signal),
  'sessions/delete':(input,signal)=>write(()=>webRpc.library.sessions.delete.mutate(input,{signal}),signal),
  'memories/list':(input,signal)=>read(()=>webRpc.library.memories.list.query(input,{signal}),signal),
  'memories/read':(input,signal)=>read(()=>webRpc.library.memories.read.query(input,{signal}),signal),
  'memories/visibility':(input,signal)=>write(()=>webRpc.library.memories.visibility.mutate(input,{signal}),signal),
  'memories/delete':(input,signal)=>write(()=>webRpc.library.memories.delete.mutate(input,{signal}),signal),
};
const library: LibraryAdapter = (operation,input,signal) => libraryOperations[operation](input,signal);
return {
  replicasHistory:(input:import('../../../src/integrations/replicas-import.mjs').ReplicasImportInput,signal?:AbortSignal)=>write(()=>webRpc.integrations.replicasHistory.mutate(input,{signal}),signal),
  devinRecording:(input:import('../../../src/application/devin-recording-http.mjs').DevinRecordingInput,signal?:AbortSignal)=>write(()=>webRpc.integrations.devinRecording.mutate(input,{signal}),signal),
  library,
  bootstrap:(signal?:AbortSignal)=>read(()=>webRpc.console.bootstrap.query(undefined,{signal}),signal),
  usage:(signal?:AbortSignal)=>read(()=>webRpc.console.usage.query(undefined,{signal}),signal),
  usageHighlights:(signal?:AbortSignal)=>read(()=>webRpc.console.usageHighlights.query(undefined,{signal}),signal),
  callTotals:(range:UsageRange,signal?:AbortSignal,basis?:'events')=>read(()=>webRpc.console.callTotals.query({range,basis},{signal}),signal),
  fileView:(path:string,signal:AbortSignal)=>read(()=>webRpc.console.fileView.query({path},{signal}),signal),
  usageTokens:(range:UsageRange,signal?:AbortSignal,basis?:'session-start')=>read(()=>webRpc.console.usageTokens.query({range,basis},{signal}),signal),
  tokenSessions:(input:import('../../../src/application/usage-range.mjs').TokenSessionsRequest,signal?:AbortSignal)=>read(()=>webRpc.console.tokenSessions.query(input,{signal}),signal),
  searchHistory:(input:import('../../../src/application/search-activity.mjs').HistoryRequest & {basis?:'events'},signal?:AbortSignal)=>read(()=>webRpc.console.searchHistory.query(input,{signal}),signal),
  usageDetails:(signal?:AbortSignal,range:UsageRange='30d')=>read(()=>webRpc.console.usageDetails.query({range},{signal}),signal),
  connection:(path:string,signal?:AbortSignal)=>read(()=>webRpc.console.connection.query({path},{signal}),signal),
  sources:(signal?:AbortSignal)=>read(()=>webRpc.console.sources.query(undefined,{signal}),signal),
  team:(signal?:AbortSignal)=>read(()=>webRpc.console.team.query(undefined,{signal}),signal),
  search:(query:string,signal?:AbortSignal,page=1)=>read(()=>webRpc.diagnostics.search.query({query,page},{signal}),signal),
  board:(input:{query?:string;cursor?:string;channel?:string;topic?:string;threadId?:number;rootsOnly?:boolean;before?:number},signal?:AbortSignal)=>read(()=>webRpc.diagnostics.board.query(input,{signal}),signal),
  connect:(provider:string,apiKey?:string,signal?:AbortSignal)=>write(()=>webRpc.integrations.connect.mutate({provider,apiKey},{signal}),signal),
  retry:(provider:string,signal?:AbortSignal)=>write(()=>webRpc.integrations.retry.mutate({provider},{signal}),signal),
  disconnect:(provider:string,signal?:AbortSignal)=>write(()=>webRpc.integrations.disconnect.mutate({provider},{signal}),signal),
  saveCredential:(credential:string,value:string,signal?:AbortSignal)=>write(()=>webRpc.integrations.saveCredential.mutate({credential,value},{signal}),signal),
  invite:(email:string,signal?:AbortSignal)=>write(()=>webRpc.console.invite.mutate({email},{signal}),signal),
  changeRole:(userId:string,role:WorkspaceRole,signal?:AbortSignal)=>write(()=>webRpc.console.changeRole.mutate({userId,role},{signal}),signal),
  removeMember:(userId:string,signal?:AbortSignal)=>write(()=>webRpc.console.removeMember.mutate({userId},{signal}),signal),
  renameOrganization:(name:string,signal?:AbortSignal)=>write(()=>webRpc.console.rename.mutate({name},{signal}),signal),
  replicasSetup:(signal?:AbortSignal)=>write(()=>webRpc.onboarding.replicasSetup.mutate(undefined,{signal}),signal),
  onboardingStatus:(signal?:AbortSignal)=>read(()=>webRpc.onboarding.status.query(undefined,{signal}),signal),
  onboardingSources:(signal?:AbortSignal)=>read(()=>webRpc.onboarding.sources.query(undefined,{signal}),signal),
  onboardingInvitations:(signal?:AbortSignal)=>read(()=>webRpc.onboarding.invitations.query(undefined,{signal}),signal),
  onboardingInvite:(email:string,signal?:AbortSignal)=>write(()=>webRpc.onboarding.invite.mutate({email},{signal}),signal),
  finishOnboarding:(signal?:AbortSignal)=>write(()=>webRpc.onboarding.finish.mutate(undefined,{signal}),signal),
};


}
