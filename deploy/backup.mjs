import {existsSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {installation,containers,lock,docker,run,root} from './installation.mjs';
import {snapshot,saveRecoveryImages,saveRecovery} from './recovery.mjs';

process.umask(0o077);
const [action,destination,...options]=process.argv.slice(2);
if(!['create','restore'].includes(action)||!destination||options.some(value=>value!=='--leave-stopped'))throw new Error('Usage: node deploy/backup.mjs create|restore /absolute/backup-directory [--leave-stopped]');
const directory=resolve(destination);
if(action==='restore') {
  const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
  if(manifest.format===2)run(process.execPath,[join(root,'deploy/restore.mjs'),'--backup',directory],{capture:false});
  else throw new Error('Unsupported backup format; retain the archive for review');
} else {
  const current=installation('deploy');
  if(!current)throw new Error('Configure the original deployment before backing it up');
  const release=lock(join(current.stateDir,'upgrade.lock'));
  try {
    if(existsSync(directory))throw new Error('Choose a new backup directory; existing backups are never overwritten');
    const inventory=containers(current.project),running=inventory.filter(c=>c.State.Running);
    if(!running.some(c=>c.Config.Labels['com.docker.compose.service']==='app'))throw new Error('Start the original application before creating its offline backup');
    const saved=snapshot(current,inventory);
    await saveRecoveryImages(directory,saved);
    const writers=running.filter(c=>['app','worker'].includes(c.Config.Labels['com.docker.compose.service']));
    const dependencies=running.filter(c=>!writers.includes(c));
    let stopped=false;
    try {
      // A partial stop can fail after stopping one writer. Recover every
      // originally running container even when Docker returns nonzero.
      stopped=true;
      if(writers.length)docker(['stop',...writers.map(c=>c.Id)]);
      if(dependencies.length)docker(['stop',...dependencies.map(c=>c.Id)]);
      await saveRecovery(directory,saved);
    } finally {
      if(stopped&&!options.includes('--leave-stopped')) {
        // Start the exact recorded containers, never rebuild/recreate through a
        // possibly newer checkout's Compose file as a side effect of backup.
        const byName=new Map(running.map(c=>[c.Config.Labels['com.docker.compose.service'],c]));
        const started=new Set(),starting=new Set();
        async function start(name) {
          if(started.has(name))return;
          if(starting.has(name))throw new Error('Saved service dependencies contain a cycle');
          starting.add(name);
          for(const dependency of Object.keys(saved.compose.services[name].depends_on||{}))await start(dependency);
          // Completed init services still carry dependency edges. Traverse them
          // to start the backing database/storage before the original app, but
          // never rerun migrations as a side effect of making a backup.
          if(!byName.has(name)){starting.delete(name);started.add(name);return;}
          const container=byName.get(name);docker(['start',container.Id]);
          const deadline=Date.now()+240000;
          for(;;) {
            const state=JSON.parse(docker(['inspect',container.Id]))[0].State;
            if(state.Running&&(!state.Health||state.Health.Status==='healthy'))break;
            if(!state.Running||Date.now()>=deadline)throw new Error('The original backup runtime did not become ready; inspect its retained containers');
            await delay(1000);
          }
          starting.delete(name);started.add(name);
        }
        for(const name of byName.keys())await start(name);
      }
    }
    console.log(JSON.stringify({backup:'complete',format:2,project:current.project,directory,leftStopped:options.includes('--leave-stopped')}));
  } finally {release();}
}
