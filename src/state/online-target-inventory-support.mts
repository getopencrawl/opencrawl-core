import {randomBytes} from 'node:crypto';
import type {PoolClient} from 'pg';

/** Private bounded scan support for the finite owning repositories. SQL is a
 * constant supplied by the owner, never an operator-selected relation. */
export interface OnlineOwnedTarget {
 kind:'target';domains:readonly string[];identity:readonly string[];value:unknown;
 maxBytes:number;sourceKey?:string;
}
export interface OnlineOwnedAuxiliary {kind:'auxiliary';owner:'slack-pacing';identity:readonly string[];proved:boolean;}
export type OnlineOwnedInventoryItem=OnlineOwnedTarget|OnlineOwnedAuxiliary;
export function targetInventoryFailure(reason:string):never{throw Object.assign(new Error('Online target inventory: '+reason),{code:'ONLINE_TARGET_INVENTORY_INVALID'});}
export async function* scanTargetInventoryIn<T extends Record<string,unknown>>(client:PoolClient,sql:string,values:unknown[]):AsyncGenerator<T>{
 const name='oc_target_'+randomBytes(12).toString('hex');let opened=false;
 try{await client.query(`DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`,values);opened=true;
  for(;;){const rows=(await client.query<T>(`FETCH FORWARD 64 FROM ${name}`)).rows;if(!rows.length)return;for(const row of rows)yield row;}
 }finally{if(opened)await client.query(`CLOSE ${name}`);}
}
export async function assertTargetInventoryBoundIn(client:PoolClient,sql:string,values:unknown[],maxBytes=64*1024*1024){
 const rows=(await client.query<{bytes:string;rows:string}>(sql,values)).rows;
 if(rows.length!==1||!/^[0-9]+$/.test(rows[0].bytes)||!/^[0-9]+$/.test(rows[0].rows)||BigInt(rows[0].bytes)>BigInt(maxBytes)||BigInt(rows[0].rows)>1048576n)targetInventoryFailure('owner rows exceed bounded readback');
}
export function targetInventoryValueBytes(value:unknown,maxBytes:number){
 const bytes=Buffer.isBuffer(value)?value.length:Buffer.byteLength(JSON.stringify(value));
 if(!Number.isSafeInteger(bytes)||bytes<1||bytes>maxBytes)targetInventoryFailure('owner value exceeds domain bound');return bytes;
}
