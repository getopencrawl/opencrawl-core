import {parseArgs} from 'node:util';
import {sessionStorage} from '../sessions/storage.mjs';
import {createReplicasState} from '../state/replicas.mjs';
import {selfhostState} from './state.mjs';

export async function main(args=process.argv.slice(2),env=process.env) {
  const {positionals,values}=parseArgs({args,allowPositionals:true,options:{'legacy-writers-drained':{type:'boolean'}}});
  const [mode]=positionals;
  if(positionals.length!==1 || (mode!=='check' && mode!=='activate')) throw new Error('Expected check or activate');
  if(mode==='activate' && !values['legacy-writers-drained']) throw new Error('Confirm all pre-bridge Replicas writers have drained');
  const {store,prefix}=sessionStorage(env);
  const {database}=await selfhostState(env);
  try {return await createReplicasState(database,store,prefix).migrate(mode);}
  finally {await database.close();}
}
if(import.meta.main) console.log(JSON.stringify(await main()));
