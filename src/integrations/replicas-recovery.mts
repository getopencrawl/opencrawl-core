import {errorInfo} from '../errors.mjs';
import {ReplicasPageError,ReplicasProviderError,type ReplicasOperation} from './replicas-api.mjs';

export type ImportOperation=ReplicasOperation|'ingest';
export type ImportIssue={
  at:string;operation:ImportOperation;reason:string;decision:'retry'|'defer'|'resize'|'reconnect';
  identityCheck?:'verified'|'identity_mismatch'|'rejected'|'unavailable';
  attempt:number;elapsedMs:number;originalHttpStatus?:number;originalOperation?:ReplicasOperation;originalRequestId?:string;httpStatus?:number;internalStatus?:number;requestId?:string;retryAt?:string;
  workspaceId?:string;chatId?:string;cursorHash?:string;pageLimit?:number;
};

export function issueFor(error:unknown,operation:ImportOperation):Pick<ImportIssue,'operation'|'reason'|'httpStatus'|'internalStatus'|'requestId'>{
  if(error instanceof ReplicasProviderError)return {operation:error.operation,reason:'provider_http',httpStatus:error.status,requestId:error.requestId};
  if(error instanceof ReplicasPageError)return {operation,reason:error.reason};
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
