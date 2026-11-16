import {digest,validateBinding} from '../../dist/src/connectors/scope.mjs';
/** Explicit volatile domain-test port. The production repository tests use PG. */
export function memorySlackCaptureState(){
 const values=new Map(),revisions=new Map(),pacing=new Map();
 const key=(binding,kind,run)=>{validateBinding(binding);return binding.rawPrefix+'capture/'+kind+'/'+(run?run+'/state.json':'catalog.json');};
 const read=(binding,path)=>{const bytes=values.get(path);if(!bytes)return null;const value=JSON.parse(bytes);if(value.scope!==digest(binding))throw Object.assign(new Error('Slack capture state scope mismatch'),{permanent:true});return value;};
 return {values,
  async readCatalog(binding,kind){return read(binding,key(binding,kind));},
  async mergeCatalog(binding,kind,input){
   const path=key(binding,kind),old=read(binding,path);if(input.scope!==digest(binding))throw new Error('Slack catalog scope mismatch');
   const value={scope:input.scope,channels:[...new Set([...(old?.channels||[]),...input.channels])]};
   if(kind==='files-v1'){value.files={...old?.files};for(const [file,channels]of Object.entries(input.files))value.files[file]=[...new Set([...(value.files[file]||[]),...channels])];}
   values.set(path,Buffer.from(JSON.stringify(value)));
  },
  async readCheckpoint(binding,kind,run){const path=key(binding,kind,run),value=read(binding,path);return value?{value,revision:String(revisions.get(path)||1)}:null;},
  async saveCheckpoint(binding,kind,run,value,revision){const path=key(binding,kind,run),prior=values.has(path)?String(revisions.get(path)||1):null;if(prior!==revision)throw Object.assign(new Error('Slack capture checkpoint changed; retry'),{status:409});const next=Number(prior||0)+1;revisions.set(path,next);values.set(path,Buffer.from(JSON.stringify(value)));return String(next);},
  async reserve(binding,method,now,interval){const id=key(binding,method),due=pacing.get(id)||0;if(due>now)return {reserved:false,waitMs:due-now};pacing.set(id,now+interval);return {reserved:true,waitMs:0};},
  async defer(binding,method,due){const id=key(binding,method);pacing.set(id,Math.max(pacing.get(id)||0,due));},
 };
}
