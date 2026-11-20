import {errorInfo} from '../errors.mjs';
import {ReplicasPageError,ReplicasProviderError,type ReplicasOperation} from './replicas-api.mjs';

export type ImportOperation=ReplicasOperation|'ingest';
export type ImportIssue={
  importId?:string;at:string;operation:ImportOperation;reason:string;decision:'retry'|'defer'|'resize'|'reconnect'|'continue';
  identityCheck?:'verified'|'identity_mismatch'|'rejected'|'unavailable';
  attempt:number;elapsedMs:number;originalHttpStatus?:number;originalOperation?:ReplicasOperation;originalRequestId?:string;httpStatus?:number;internalStatus?:number;requestId?:string;retryAt?:string;
  workspaceId?:string;chatId?:string;cursorHash?:string;pageLimit?:number;
  bytesRead?:number;observedBytes?:number;limitBytes?:number;
  missingResource?:ReplicasProviderError['missingResource'];
  workspaceAbsentAt?:string;
  workspaceExport?:{result:'scoped';total:number;hasMore:boolean;onFirstPage:boolean}|{result:'scope_mismatch'|'unavailable'};
  workspaceInventory?:{result:'listed'|'absent'|'waking';chats:number;savedChats?:number}|{result:'unavailable';httpStatus?:number};
};

export function issueFor(error:unknown,operation:ImportOperation):Pick<ImportIssue,'operation'|'reason'|'httpStatus'|'internalStatus'|'requestId'|'missingResource'|'observedBytes'|'limitBytes'>{
  if(error instanceof ReplicasProviderError)return {operation:error.operation,reason:'provider_http',httpStatus:error.status,requestId:error.requestId,missingResource:error.missingResource};
  if(error instanceof ReplicasPageError)return {operation,reason:error.reason,observedBytes:error.observedBytes,limitBytes:error.limitBytes};
  if(operation==='ingest'){
    const {status,permanent}=errorInfo(error);
    return {operation,reason:permanent?'record_rejected':'ingest_failed',internalStatus:status};
  }
  return {operation,reason:error instanceof Error&&error.name==='TimeoutError'?'timeout':'transport'};
}
export function retryDelay(attempt:number,minMs:number,providerMs=0){
  return Math.max(providerMs,Math.min(6*60*60*1000,minMs*2**Math.min(attempt-1,16)));
}
export function authDenied(error:unknown):error is ReplicasProviderError{
  return error instanceof ReplicasProviderError&&(error.status===401||error.status===403);
}
