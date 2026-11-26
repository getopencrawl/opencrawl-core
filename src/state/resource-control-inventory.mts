import {digest} from '../sessions/event-identity.mjs';
import {retainedOwnerScopes} from '../sessions/retained-owners.mjs';
import {MAX_CONTROL_BYTES,type ControlKind} from '../sessions/controls.mjs';
import {isSessionHarness,type ObjectStore} from '../sessions/types.mjs';
import {checkedControl,type ControlIdentity,type RetainedControl} from './resource-control-rows.mjs';

export function sourceKey(prefix:string,k:ControlIdentity) {
  return prefix+'/'+k.owner+'/controls/'+k.kind+'/'+k.harness+'/'+k.nameHash+'.json';
}
export async function readRetainedControl(store:ObjectStore,prefix:string,key:ControlIdentity):Promise<RetainedControl|null> {
  try{
    const {data,version}=await store.readVersion(sourceKey(prefix,key),{maxBytes:MAX_CONTROL_BYTES});
    if(data===null && version===null)return null;
    if(!data || !(typeof version==='string'&&version.length || typeof version==='number'&&Number.isFinite(version)))throw Error();
    return {...key,version,hash:digest(data),control:checkedControl(data,key)};
  }catch{throw Error('Retained resource control is unreadable or invalid');}
}
async function* directory(store:ObjectStore,prefix:string,owner:string,kind:ControlKind) {
  const root=prefix+'/'+owner+'/controls/'+kind+'/',tokens=new Set<string>();
  let cursor:string|null=null,previous='';
  do{
    const page=await store.listPage(root,{requireComplete:true,maxKeys:128,continuationToken:cursor});
    if(page.prefixes?.length)throw Error('Unexpected resource control subtree');
    const keys:ControlIdentity[]=[];
    for(const path of page.keys){
      if(!path.startsWith(root) || previous>=path)throw Error('Invalid resource control inventory order');
      previous=path;
      const tail=path.slice(root.length),[harness,file,...extra]=tail.split('/');
      if(!tail || isSessionHarness(harness)&&file===''&&!extra.length)continue; // S3 directory marker.
      if(!isSessionHarness(harness)||extra.length||!file||!/^[a-f0-9]{64}\.json$/.test(file))throw Error('Unknown resource control object');
      keys.push({owner,kind,harness,nameHash:file.slice(0,-5)});
    }
    yield keys;
    cursor=page.nextToken;
    if(cursor!==null){if(typeof cursor!=='string'||!cursor||tokens.has(cursor))throw Error('Invalid resource control inventory cursor');tokens.add(cursor);}
  }while(cursor!==null);
}

/** Discover only the two control trees per owner. Directory listings overlap;
 * object GETs and database batches are bounded independently of owner size. */
export async function scanResourceControls(store:ObjectStore,prefix:string,organizationId:string|null,visit:(items:RetainedControl[])=>Promise<void>) {
  let owners:string[]=[];
  async function batch(){
    let streams=owners.flatMap(owner=>(['memories','sessions'] as const).map(kind=>directory(store,prefix,owner,kind)));
    owners=[];
    while(streams.length){
      const pages=await Promise.all(streams.map(s=>s.next()));
      streams=streams.filter((_,i)=>!pages[i]!.done);
      const keys=pages.flatMap(page=>page.done?[]:page.value);
      for(let i=0;i<keys.length;i+=16){
        const items=await Promise.all(keys.slice(i,i+16).map(k=>readRetainedControl(store,prefix,k)));
        if(items.some(item=>item===null))throw Error('Listed resource control disappeared');
        await visit(items as RetainedControl[]);
      }
    }
  }
  // Transport errors can contain private keys. Report errors without object paths or document bodies.
  try{
    for await(const owner of retainedOwnerScopes(store,prefix,organizationId?digest(organizationId):undefined,true)){
      owners.push(owner);if(owners.length===24)await batch();
    }
    if(owners.length)await batch();
  }catch(error){
    if(error instanceof Error && /^(Retained resource control is unreadable or invalid|Listed resource control disappeared|Unknown resource control object|Resource control verification differs|Resource control readback differs)$/.test(error.message))throw error;
    throw Error('Resource control inventory did not complete');
  }
}
