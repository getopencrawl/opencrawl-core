import {createTRPCClient, httpLink, type TRPCClient} from '@trpc/client';
import type {ProductRouter} from '../../../dist/src/application/rpc.mjs';
import type {LibraryAdapter, LibraryContract, LibraryOperation} from '../../../src/application/library-types.mjs';
import type {WorkspaceRole} from './api.ts';
import {rpcTransportOptions, rpcRead as read, rpcWrite as write} from './transport.ts';
export function createProductApi(webRpc: TRPCClient<ProductRouter> = createTRPCClient<ProductRouter>({links: [httpLink(rpcTransportOptions())]})) {
const libraryOperations: {[O in LibraryOperation]: (input: LibraryContract[O]['input'], signal: AbortSignal) => Promise<LibraryContract[O]['output']>} = {
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
  library,
  bootstrap:(signal?:AbortSignal)=>read(()=>webRpc.console.bootstrap.query(undefined,{signal}),signal),
  usage:(signal?:AbortSignal)=>read(()=>webRpc.console.usage.query(undefined,{signal}),signal),
  sources:(signal?:AbortSignal)=>read(()=>webRpc.console.sources.query(undefined,{signal}),signal),
  team:(signal?:AbortSignal)=>read(()=>webRpc.console.team.query(undefined,{signal}),signal),
  search:(query:string,signal?:AbortSignal)=>read(()=>webRpc.diagnostics.search.query({query},{signal}),signal),
  board:(input:{topic?:string;before?:number},signal?:AbortSignal)=>read(()=>webRpc.diagnostics.board.query(input,{signal}),signal),
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
