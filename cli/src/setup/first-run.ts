import {readdirSync} from 'node:fs';
import {readCaptureConfig} from '../capture/runtime.ts';
import {withEnvironmentTokenOrigin} from '../environment-token.ts';
import {apiOrigin} from '../oauth.ts';
import {readServerSetup,serverScope} from './api.ts';
import {nextSetupAction} from './next.ts';
import {chosen,readSetupState,readStateKey,scopeKey,setupRoot,updateSetupState,type SetupState} from './state.ts';

// Recording can be declined before a capture configuration is ever created.
function unboundSetupComplete(api?:string){
 let files:string[];
 try{files=readdirSync(setupRoot());}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
 const states=files.filter(file=>/^[a-f0-9]{64}\.json$/.test(file)).map(file=>readStateKey(file.slice(0,-5)))
  .filter((state):state is SetupState=>state!==null&&(!api||state.scope.api===api))
  .sort((a,b)=>b.acceptedAt.localeCompare(a.acceptedAt));
 const latest=states[0];
 return Boolean(latest&&!latest.installationId&&latest.firstRun!=='choosing'&&!chosen(latest.selections,'plugins').length&&!chosen(latest.selections,'history').length);
}

export async function rememberFinishedSetup(state:SetupState){
 if(state.firstRun==='complete')return true;
 if(state.firstRun==='choosing')return false;
 const saved=await updateSetupState(state.scope,current=>{
  if(!current)throw new Error('Saved setup disappeared while checking completion.');
  return current.installationId===state.installationId&&current.acceptedAt===state.acceptedAt&&current.firstRun!=='choosing'
   ?{...current,firstRun:'complete'}:current;
 });
 return saved.acceptedAt===state.acceptedAt&&saved.installationId===state.installationId&&saved.firstRun==='complete';
}

export async function needsFirstRunSetup(requestedApi?:string,read=readServerSetup){
 const config=readCaptureConfig(),api=requestedApi?apiOrigin(requestedApi):undefined;
 if(!config||(api&&api!==config.api))return !unboundSetupComplete(api);
 if(!config.owner||config.authPending)return true;
 const scope={api:config.api,...config.owner};
 const state=readSetupState(scope);
 if(!state||!state.installationId||state.installationId!==config.installationId||state.firstRun==='choosing')return true;
 if(state.firstRun==='complete')return false;
 if(state.firstRun==='ready'&&state.historyJob&&!chosen(state.selections,'plugins').length)return true;
 // Older releases saved choices before native verification finished. Consult the
 // same proof as setup, then cache completion for future offline invocations.
 let server;
 try{server=await withEnvironmentTokenOrigin(api,()=>read(scope.api));}catch{return true;}
 if(scopeKey(serverScope(scope.api,server))!==scopeKey(scope)||nextSetupAction(state,server).kind!=='complete')return true;
 return !await rememberFinishedSetup(state);
}
