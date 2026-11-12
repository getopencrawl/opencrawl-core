// Disposable HTTP fixture: real self-host identity/application, local test objects.
// Production object-storage and Compose persistence are covered by self-host CI.
import {createServer} from 'node:http';
import {join} from 'node:path';
import {mock} from 'node:test';
import {createLocalIdentity} from '../../dist/src/identity/better-auth.mjs';
import {selfhostApplication} from '../../dist/src/selfhost/application.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';

const config=JSON.parse(process.env.OPENCRAWL_RESTART_TEST);
if(config.now)mock.timers.enable({apis:['Date'],now:config.now});
let app;
const server=createServer((req,res)=>app(req,res));
await new Promise(resolve=>server.listen(config.port||0,'127.0.0.1',resolve));
const origin='http://localhost:'+server.address().port;
const settings={organizationId:'org_restarttest',url:origin,authOrigin:origin+'/api/auth',clientId:'opencrawl-cli',
  authSecret:config.secret,identityPath:join(config.dir,'identity.sqlite'),setupToken:config.setup,
  search:{endpoint:'http://127.0.0.1:1',environment:'selfhost',tenantId:'org_restarttest'}};
const identity=await createLocalIdentity({url:origin,secret:config.secret,databasePath:settings.identityPath,organizationId:settings.organizationId});
await identity.ready();
app=selfhostApplication({settings,identity,store:createLocalSessionStore(config.dir),prefix:'sessions/restart/v1',readAsset:async()=>''});
process.on('SIGTERM',()=>server.close(()=>{identity.close();process.exit(0);}));
process.send({port:server.address().port,pid:process.pid});
