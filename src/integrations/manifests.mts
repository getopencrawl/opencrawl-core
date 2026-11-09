import {readFileSync} from 'node:fs';
import type {ConnectorManifest} from './types.mjs';
const providers=new Set(['slack','googledrive','notion','circleback','granola']);
export function connectorManifest(provider:string):ConnectorManifest {
  if(!providers.has(provider))throw new Error('Unknown connector manifest');
  return JSON.parse(readFileSync(new URL('./connectors/'+provider+'.json',import.meta.url),'utf8'));
}
