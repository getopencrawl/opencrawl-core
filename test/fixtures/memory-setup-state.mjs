import {randomUUID} from 'node:crypto';
import {sessionScope} from '../../dist/src/sessions/event-identity.mjs';
import {validateSetupState} from '../../dist/src/setup/state.mjs';
/** Explicit volatile test port; never imported by the runtime. */
export function memorySetupState(){
 const rows=new Map();
 return {async read(scope){const row=rows.get(sessionScope(scope));return row?structuredClone(row):{record:null,version:null};},
  async save(scope,version,input){const key=sessionScope(scope),record=validateSetupState(input,scope);if((rows.get(key)?.version??null)!==version)return false;
   rows.set(key,{record:structuredClone(record),version:randomUUID()});return true;}};
}
