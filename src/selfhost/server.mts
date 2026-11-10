import {pathToFileURL} from 'node:url';
import {selfhostSettings} from './settings.mjs';
import {selfhostServices} from './services.mjs';
import {selfhostApplication} from './application.mjs';
import {createLocalIdentity} from '../identity/better-auth.mjs';
import {standaloneStorage} from '../sessions/standalone.mjs';
import {createDrainableServer} from '../application/request-lifecycle.mjs';
export async function startSelfhost(env:NodeJS.ProcessEnv=process.env){
  const settings=selfhostSettings(env),{store,prefix}=standaloneStorage(env);
  await store.checkAccess();
  const identity=createLocalIdentity({url:settings.url,secret:settings.authSecret,databasePath:settings.identityPath,organizationId:settings.organizationId});
  await identity.ready();
  const services=selfhostServices(settings,store,env);
  const {server,shutdown}=createDrainableServer(selfhostApplication({settings,store,prefix,identity,...services}),{analytics:{async close(){services.close();}}});
  server.requestTimeout=60000;server.headersTimeout=10000;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(Number(env.PORT||8092),env.HOST||'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  // Recovery has the same durable create fence as an explicit Retry in the UI.
  services.recover().catch(()=>console.error(JSON.stringify({event:'integration.recovery_failed'})));
  process.once('SIGTERM',()=>{void shutdown();});process.once('SIGINT',()=>{void shutdown();});
  return {server,shutdown};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await startSelfhost();
