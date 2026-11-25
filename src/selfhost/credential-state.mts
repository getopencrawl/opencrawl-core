import {parseArgs} from 'node:util';
import {sessionStorage} from '../sessions/storage.mjs';
import {createCredentialState} from '../state/credentials.mjs';
import {selfhostState} from './state.mjs';

export async function main(args=process.argv.slice(2),env=process.env) {
  const {positionals,values}=parseArgs({args,allowPositionals:true,options:{'legacy-writers-drained':{type:'boolean'}}});
  const [mode]=positionals;
  if(positionals.length!==1 || (mode!=='plan' && mode!=='activate' && mode!=='verify' && mode!=='status'))
    throw new Error('Expected plan, activate, verify or status');
  if(mode==='activate' && !values['legacy-writers-drained'])
    throw new Error('Drain all older credential writers and confirm with --legacy-writers-drained');
  const {store,prefix}=sessionStorage(env);
  const {database}=await selfhostState(env);
  try {
    const state=createCredentialState(database,store,prefix);
    return mode==='status'?await state.status():await state.migrate(mode);
  } finally {await database.close();}
}
if(import.meta.main) console.log(JSON.stringify(await main()));
