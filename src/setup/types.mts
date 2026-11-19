/** Local observations describe configuration; only server evidence verifies a client. */
export const SETUP_CLIENTS = ['claude-code','codex','cursor','grok-bot','antigravity','devin','claude-desktop','chatgpt'] as const;
export type SetupClient = typeof SETUP_CLIENTS[number];
export const SETUP_PLUGIN_STATES = ['not_selected','pending','prepared','installed','error'] as const;
export type SetupPluginState = typeof SETUP_PLUGIN_STATES[number];
export interface SetupHistoryProgress {state:'not_started'|'running'|'complete'|'failed';completed:number;total?:number;error?:string}
export interface SetupClientObservation {
  client:SetupClient; installed:boolean; forward:boolean; history:'skip'|'import';
  /** Latest CLI observation; prepared files do not establish native activation. */
  pluginState?:SetupPluginState;
  historyProgress:SetupHistoryProgress; hookTrust:'unknown'|'pending'|'trusted'|'not_required';
}
export interface SetupProof {
  state:'not_selected'|'pending'|'waiting_capture'|'waiting_index'|'verified'|'expired';
  id?:string;marker?:string;issuedAt?:string;expiresAt?:string;verifiedAt?:string;
  sessionId?:string;eventId?:string;passageId?:string;
}
export interface SetupHumanTask {id:string;kind:'hook_trust'|'mcp_auth'|'native_event';client:SetupClient;title:string;instruction:string}
export interface SetupClientStatus extends SetupClientObservation {
  /** Latest server receipt attributable to this installation and agent type. */
  lastSeenAt?:string;
  forwardSince?:string;
  captureObservedAt?:string;
  mcp:{state:'pending'|'observed'|'authenticated';observedAt?:string};
  proof:SetupProof;humanTasks:SetupHumanTask[];
}
export interface SetupInstallation {
  installationId:string;machine:{id:string;label:string};
  /** Server receipt time of a setup report or a selected client's live capture upload, at minute resolution. */
  updatedAt:string;
  clients:SetupClientStatus[];
}
export interface SetupStatus {
  schemaVersion:1;scope:{tenantId:string;userId:string};
  /** Older servers reject unknown observation fields; clients negotiate this field. */
  pluginStateSupported?:true;
  firstWin:{installationId:string;client:SetupClient;verifiedAt:string}|null;
  installations:SetupInstallation[];
}
