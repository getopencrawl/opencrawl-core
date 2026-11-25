import {createHash} from 'node:crypto';
import {onboardingKinds,validateReceipt,validateReceiptScope,type ReceiptMap,type OnboardingKind,type OnboardingReceipt} from '../onboarding-receipts.mjs';
import type {ApplicationTransaction} from './postgres.mjs';

export function onboardingOwnerCheck(organizationId:string|null) {
  const tenant=organizationId && 'tenants/'+createHash('sha256').update(organizationId).digest('hex')+'/users/';
  return (owner:string)=>{
    validateReceiptScope(owner);
    if(tenant && !owner.startsWith(tenant))throw Error('Onboarding owner outside configured organization');
  };
}

export function selectedReceipts(receipts:ReceiptMap|null,kinds:readonly OnboardingKind[]) {
  const result:ReceiptMap={};
  for(const kind of kinds)if(receipts?.[kind])result[kind]=receipts[kind];
  return result;
}

export function checkMilestone(kind:OnboardingKind,value:OnboardingReceipt) {
  validateReceipt(value);
  if(!onboardingKinds.includes(kind))throw Error('Invalid onboarding milestone');
}

export async function writeOnboardingRow(db:Pick<ApplicationTransaction,'query'>,namespace:string,source:string,
  phase:'postgres'|'importing',owner:string,kind:OnboardingKind,value:OnboardingReceipt) {
  const missingClient=kind==='mcp' && !('client' in value);
  const first=missingClient?{...value,client:null}:value;
  // Lock the source-bound authority within the SQL write. An older operator
  // restoring this namespace cannot race a native receiver or admit stale writes.
  const {rows:[row]}=await db.query(`INSERT INTO opencrawl_onboarding_owners AS o(namespace,owner,receipts)
    SELECT namespace,$2,jsonb_build_object($3::text,$4::jsonb) FROM opencrawl_onboarding_authority
    WHERE namespace=$1 AND source=$6::jsonb AND phase=$7 FOR SHARE
    ON CONFLICT(namespace,owner) DO UPDATE SET receipts=o.receipts || jsonb_build_object($3::text,
      CASE WHEN $3='completed' AND o.receipts ? 'completed' THEN o.receipts->'completed'
           WHEN $5 THEN $4::jsonb || jsonb_build_object('client',o.receipts->'mcp'->'client')
           ELSE $4::jsonb END)
    RETURNING receipts->$3::text AS value`,[namespace,owner,kind,JSON.stringify(first),missingClient,source,phase]);
  if(!row)throw Error('PostgreSQL onboarding authority is not active for this installation');
  return validateReceipt(row.value);
}
