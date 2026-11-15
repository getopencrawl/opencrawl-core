import {join} from 'node:path';
import {agentSkills, skillRevision} from './skills.ts';
import {read, version} from './distribution.ts';
import {atomicJson, configDir} from './session.ts';

/** Activate an already-installed skill after binary delegation. This is local
 * work only: no update check, network, authentication, capture or trust changes.
 * Lifecycle callers never wait for the installation lock and retry on a later
 * event. A profile-scoped version/revision receipt makes later events read-only. */
export async function refreshManagedSkills(api:string, {hook=false}: {hook?:boolean}={}) {
  if(process.env.OPENCRAWL_NO_UPDATE==='1')return;
  const file=join(configDir(),'skills-update.json'),previous=read(file);
  if(previous?.version===version&&previous.revision===skillRevision&&
    (previous.complete||previous.checkedAt>Date.now()-15*60_000))return;
  try {
    const data=await agentSkills('refresh',api,hook?{lockWaitMs:0,deadline:Date.now()+750}:{}),rows=data.results;
    const conflicts=rows.filter(row=>row.status==='conflict').length,errors=rows.filter(row=>row.status==='error').length;
    const deferred=rows.some(row=>row.status==='deferred');
    const result={status:conflicts||errors?'attention_required':deferred?'deferred':'current',
      updated:rows.filter(row=>['installed','updated'].includes(row.status)).length,conflicts,errors};
    // Budget exhaustion or lock contention must be eligible for the next event.
    if(!deferred)atomicJson(file,{version,revision:skillRevision,checkedAt:Date.now(),complete:!errors,result});
    if(errors&&!hook)process.stderr.write('opencrawl: Managed skill refresh needs attention; run opencrawl skills refresh --json.\n');
    return result;
  } catch { /* Sandboxed or busy configuration never blocks native lifecycle. */ }
}
