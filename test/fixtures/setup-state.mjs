/** Synthetic complete legacy aggregate, including a deliberately expired proof.
 * Parent upgrade/restore fixtures reuse these bytes; no real receipt is copied. */
export function legacySetupState(scope={tenantId:'org_setup',userId:'user_fixture'}){
 const at='2026-11-14T12:00:00.000Z',id='a'.repeat(32),sessionId='synthetic-native-session';
 return {schemaVersion:1,scope,firstWin:null,installations:[{installationId:'setup-installation',machine:{id:'setup-machine',label:'Synthetic machine'},updatedAt:at,clients:[{
  client:'codex',installed:false,pluginState:'prepared',forward:true,history:'import',historyProgress:{state:'complete',completed:3,total:3},hookTrust:'pending',forwardSince:at,
  evidence:{proof:{state:'waiting_index',id,marker:'opencrawlverify'+id,issuedAt:at,expiresAt:'2026-11-14T13:00:00.000Z',sessionId,eventId:'native-message'},
   capture:{sessionId,eventId:'native-message',timestamp:at,observedAt:at},mcpCall:{receipt:'opencrawlmcp'+'b'.repeat(32),issuedAt:at},
   nativeCalls:[{callId:'native-call',sessionId}],nativeResults:[{callId:'native-call',sessionId,eventId:'native-result',observedAt:at}],mcpNative:{sessionId,eventId:'native-result',observedAt:at}}
 }]}]};
}
