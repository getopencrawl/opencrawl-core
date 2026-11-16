import {createApplicationDatabase} from '../../dist/src/state/postgres.mjs';
import {createApplicationState} from '../../dist/src/state/application.mjs';
import {createPostgresEventIdentities} from '../../dist/src/sessions/postgres-identities.mjs';
// Disposable HTTP fixture: real self-host identity/application, local test objects.
// Production object-storage and Compose persistence are covered by self-host CI.
import {createServer} from 'node:http';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mock} from 'node:test';
import {createLocalIdentity} from '../../dist/src/identity/better-auth.mjs';
import {selfhostApplication} from '../../dist/src/selfhost/application.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';

const config=JSON.parse(process.env.OPENCRAWL_RESTART_TEST);
if(config.now)mock.timers.enable({apis:['Date'],now:config.now});
const database=createApplicationDatabase({connectionString:config.connectionString,namespace:config.namespace});
await database.ready();const state=await createApplicationState({database});
const eventIdentities=createPostgresEventIdentities({connectionString:config.connectionString,namespace:config.namespace});
let app;
const server=createServer((req,res)=>app(req,res));
await new Promise(resolve=>server.listen(config.port||0,'127.0.0.1',resolve));
const origin='http://localhost:'+server.address().port;
const settings={organizationId:'org_restarttest',url:origin,authOrigin:origin+'/api/auth',clientId:'opencrawl-cli',
  authSecret:config.secret,setupToken:config.setup,
  search:{endpoint:pathToFileURL(join(config.dir,'search.sqlite')).href.replace('file:','sqlite:'),environment:'selfhost',tenantId:'org_restarttest'}};
const identity=await createLocalIdentity({url:origin,secret:config.secret,database,organizationId:settings.organizationId});
await identity.ready();
app=selfhostApplication({settings,state,eventIdentities,identity,store:createLocalSessionStore(config.dir),prefix:'sessions/restart/v1',...(config.browser?{}:{readAsset:async()=>''})});
process.on('SIGTERM',()=>{
  server.close(async()=>{await identity.close();await eventIdentities.close();await database.close();process.exit(0);});
  server.closeAllConnections();
});
process.send({port:server.address().port,pid:process.pid});
