import {createHash} from 'node:crypto';
import {apiOrigin} from '../oauth.ts';

export function setupPluginIdentity(api:string){
  const origin=apiOrigin(api),key=createHash('sha256').update(origin).digest('hex').slice(0,12);
  return {api:origin,key,name:'opencrawl',marketplace:'opencrawl-cli'};
}

/** Previous desktop installations and exported Devin bundles use this identity. */
export function scopedPluginIdentity(api:string){
  const identity=setupPluginIdentity(api);
  return {...identity,name:'opencrawl-'+identity.key,marketplace:'opencrawl-cli-'+identity.key};
}
