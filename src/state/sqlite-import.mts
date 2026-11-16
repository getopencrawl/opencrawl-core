/** Offline migration only. Runtime repositories never import node:sqlite. */
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {stat} from 'node:fs/promises';
import type {PoolClient} from 'pg';
export type ImportMode='check'|'migrate'|'verify';
export type ColumnType='text'|'number'|'bigint'|'boolean'|'date'|'json';
export interface ImportTable {name:string;columns:Record<string,ColumnType>;primary:string[];order:number}
export interface ImportDigest {rows:number;sha256:string}
export interface ImportReceipt {table:string;source:ImportDigest;target:ImportDigest|null;matches:boolean}
export const identifier=(value:string)=>{if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))throw new Error('Invalid migration schema identifier');return '"'+value+'"';};
export function canonical(value:unknown):string{
  if(value===undefined)throw new Error('Undefined migration value');
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
}
export function normalize(value:unknown,type:ColumnType):unknown{
  if(value===null)return null;
  if(type==='text'){if(typeof value!=='string')throw new Error('Invalid text in legacy identity');return value;}
  if(type==='boolean'){if(value===true||value===1)return true;if(value===false||value===0)return false;throw new Error('Invalid boolean in legacy identity');}
  if(type==='date'){const date=value instanceof Date?value:new Date(typeof value==='bigint'?Number(value):value as string|number);if(!Number.isFinite(date.getTime()))throw new Error('Invalid date in legacy identity');return date.toISOString();}
  if(type==='number'){const number=Number(value);if(!Number.isSafeInteger(number))throw new Error('Invalid number in legacy identity');return number;}
  if(type==='bigint'){try{return BigInt(value as string|number|bigint).toString();}catch{throw new Error('Invalid integer in legacy identity');}}
  if(type==='json'){try{return typeof value==='string'?JSON.parse(value):value;}catch{throw new Error('Invalid JSON in legacy identity');}}
  throw new Error('Unsupported migration column');
}
export async function openLegacySqlite(path:string){
  if(!(await stat(path)).isFile())throw new Error('Legacy SQLite source must be a regular file');
  const source=new DatabaseSync(path,{readOnly:true});
  try {if(source.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Error('Legacy SQLite integrity check failed');source.exec('BEGIN');return source;}
  catch(error){source.close();throw error;}
}
export function sourceTables(source:DatabaseSync){return source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>String(row.name));}
export function sourceColumns(source:DatabaseSync,table:ImportTable){
  const columns=source.prepare(`PRAGMA table_info(${identifier(table.name)})`).all().map(row=>String(row.name));
  if(columns.some(column=>!Object.hasOwn(table.columns,column))||table.primary.some(column=>!columns.includes(column)))throw new Error('Legacy identity has unknown or missing columns in '+table.name);
  return columns.sort();
}
function normalizedRow(row:Record<string,unknown>,table:ImportTable,columns:string[]){return Object.fromEntries(columns.map(column=>[column,normalize(row[column],table.columns[column]!)]));}
function order(table:ImportTable,sqlite=false){return table.primary.map(column=>identifier(column)+(table.columns[column]==='text'?' COLLATE '+(sqlite?'BINARY':'"C"'):'')).join(',');}
export function* sourceRows(source:DatabaseSync,table:ImportTable,columns:string[]){
  for(const row of source.prepare(`SELECT ${columns.map(identifier).join(',')} FROM ${identifier(table.name)} ORDER BY ${order(table,true)}`).iterate())yield normalizedRow(row,table,columns);
}
export function digestRows(rows:Iterable<Record<string,unknown>>):ImportDigest{
  const hash=createHash('sha256');let count=0;for(const row of rows){hash.update(canonical(row)+'\n');count++;}return {rows:count,sha256:hash.digest('hex')};
}
export async function targetDigest(client:PoolClient,schema:string,table:ImportTable,columns:string[]):Promise<ImportDigest|null>{
  const qualified=identifier(schema)+'.'+identifier(table.name);
  if(!(await client.query('SELECT to_regclass($1) AS name',[qualified])).rows[0]?.name)return null;
  const hash=createHash('sha256');let count=0,last:unknown[]|undefined;
  for(;;){
    const fields=columns.map(identifier).join(','),keys=table.primary.map(column=>identifier(column)+(table.columns[column]==='text'?' COLLATE "C"':''));
    const where=last?` WHERE (${keys.join(',')}) > (${last.map((_,i)=>'$'+(i+1)).join(',')})`:'';
    const {rows}=await client.query(`SELECT ${fields} FROM ${qualified}${where} ORDER BY ${order(table)} LIMIT 256`,last);
    for(const row of rows){const normalized=normalizedRow(row,table,columns);hash.update(canonical(normalized)+'\n');count++;}
    if(rows.length<256)break;
    last=table.primary.map(column=>rows.at(-1)![column]);
  }
  return {rows:count,sha256:hash.digest('hex')};
}
export async function copyTable(source:DatabaseSync,client:PoolClient,schema:string,table:ImportTable,columns:string[]){
  const qualified=identifier(schema)+'.'+identifier(table.name);let batch:Record<string,unknown>[]=[];
  async function flush(){
    if(!batch.length)return;const values:unknown[]=[];
    const tuples=batch.map(row=>'('+columns.map(column=>{const value=row[column];values.push(table.columns[column]==='json'&&value!==null?JSON.stringify(value):value);return '$'+values.length;}).join(',')+')');
    await client.query(`INSERT INTO ${qualified} (${columns.map(identifier).join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (${table.primary.map(identifier).join(',')}) DO NOTHING`,values);batch=[];
  }
  for(const row of sourceRows(source,table,columns)){batch.push(row);if(batch.length===100)await flush();}await flush();
}
