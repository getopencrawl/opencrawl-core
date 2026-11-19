import {readFileSync} from 'node:fs';
import type {ConnectorManifest} from './types.mjs';
import {linearManifest} from './linear-upstream.mjs';
const providers=new Set(['slack','notion','circleback','granola','linear']);
export function connectorManifest(provider:string):ConnectorManifest {
  if(!providers.has(provider))throw new Error('Unknown connector manifest');
  if(provider==='linear')return linearManifest();
  return JSON.parse(readFileSync(new URL('./connectors/'+provider+'.json',import.meta.url),'utf8'));
}
