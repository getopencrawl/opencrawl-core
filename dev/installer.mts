import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {chmodSync,existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,renameSync,rmSync,statfsSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

type Pin={url:string;sha256:string;member?:string;version?:string};
interface Pins {kind:Pin;kubectl:Pin;helm:Pin;airbyte:Pin;kindNode:string;declarative:{version:string;imageSha:string}}
interface State {
  format:1;root:string;project:string;createdAt:string;port:number;airbytePort:number;origin:string;
  organization:string;email:string;password:string;authSecret:string;setupToken:string;connectorKey:string;
  s3Key:string;s3Secret:string;temporalPassword:string;airbytePassword:string;airbyteClientId:string;
  airbyteClientSecret:string;airbyteDbPassword:string;airbyteStorageSecret:string;
  workspaceId?:string;airbyteInstalled?:boolean;airbyteConfigHash?:string;verifiedAt?:string;startedAt?:string;
}
const root=realpathSync(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const stateDir=join(root,'.opencrawl-dev'),stateFile=join(stateDir,'state.json'),bin=join(stateDir,'bin');
const pins=JSON.parse(readFileSync(join(root,'dev/pins.json'),'utf8')) as Pins;
const action=process.argv[2]||'up';
if(!['up','demo','status','stop','reset'].includes(action)||process.argv.slice(3).some(x=>x!=='--yes'))throw new Error('Use ./dev/up [up|demo|status|stop|reset --yes]');
process.umask(0o077);
mkdirSync(stateDir,{recursive:true,mode:0o700});
if(lstatSync(stateDir).isSymbolicLink())throw new Error('Refusing symlinked state');
const lock=join(stateDir,'installer.lock');
if(existsSync(lock)){
  const pid=Number(readFileSync(lock,'utf8'));
  if(!Number.isInteger(pid)||pid<1)throw new Error('Invalid installer lock; inspect .opencrawl-dev/installer.lock');
  let alive=true;try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
  if(alive)throw new Error(`Another installer is running (PID ${pid})`);
  rmSync(lock);
}
writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
const cleanup=()=>{if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))rmSync(lock);};
process.on('exit',cleanup);
process.on('SIGINT',()=>process.exit(130));process.on('SIGTERM',()=>process.exit(143));

function run(command:string,args:string[],options:{capture?:boolean;input?:string;allowFailure?:boolean}={}):string{
  const result=spawnSync(command,args,{cwd:root,env:{...process.env,DO_NOT_TRACK:'1'},encoding:'utf8',input:options.input,
    stdio:options.capture?['pipe','pipe','pipe']:['pipe','inherit','inherit'],maxBuffer:32*1024*1024});
  if(result.error)throw result.error;
  if(result.status!==0&&!options.allowFailure)throw new Error(`${command.split('/').at(-1)} ${args[0]||''} failed (${result.status}); inspect the preceding output. Existing data is preserved.`);
  return result.status===0?(result.stdout||''):'';
}
function privateFile(path:string,value:unknown){
  if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error(`Refusing symlink ${path}`);
  const tmp=path+'.tmp';writeFileSync(tmp,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(tmp,path);chmodSync(path,0o600);
}
const secret=()=>randomBytes(24).toString('hex');
function port(value:string|undefined,fallback:number){const p=Number(value||fallback);if(!Number.isInteger(p)||p<1024||p>65535)throw new Error('Development ports must be integers from 1024 to 65535');return p;}
let state:State;
if(existsSync(stateFile)){
  state=JSON.parse(readFileSync(stateFile,'utf8')) as State;
  if(state.format!==1||state.root!==root||!/^ocdev-[a-f0-9]{12}$/.test(state.project)||!/^org_[a-f0-9]{24}$/.test(state.organization))throw new Error('Development state belongs to another clone or has an unsupported format');
  if(state.port!==port(String(state.port),8092)||state.airbytePort!==port(String(state.airbytePort),8000))throw new Error('Invalid saved ports');
}else{
  if(!['up','demo'].includes(action))throw new Error('No development installation exists in this clone');
  const p=port(process.env.OPENCRAWL_DEV_PORT,8092),ap=port(process.env.OPENCRAWL_DEV_AIRBYTE_PORT,8000);
  if(p===ap)throw new Error('Application and Airbyte ports must differ');
  const origin=process.env.OPENCRAWL_DEV_ORIGIN||`http://localhost:${p}`,u=new URL(origin);
  if(u.origin!==origin||!(u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw new Error('Dev origin must be loopback HTTP or an HTTPS origin you control');
  state={format:1,root,project:'ocdev-'+randomBytes(6).toString('hex'),createdAt:new Date().toISOString(),port:p,airbytePort:ap,origin,
    organization:'org_'+randomBytes(12).toString('hex'),email:'developer@opencrawl.example',password:secret(),authSecret:secret(),setupToken:secret(),connectorKey:randomBytes(32).toString('base64'),
    s3Key:'dev'+randomBytes(10).toString('hex'),s3Secret:secret(),temporalPassword:secret(),airbytePassword:secret(),airbyteClientId:randomUUID(),airbyteClientSecret:secret(),airbyteDbPassword:secret(),airbyteStorageSecret:secret()};
  privateFile(stateFile,state);
}
function save(){privateFile(stateFile,state);}
const node=state.project+'-control-plane',kubeconfig=join(stateDir,'kubeconfig'),envFile=join(stateDir,'compose.env'),override=join(stateDir,'compose.json');
const compose=(args:string[],options:Parameters<typeof run>[2]={})=>run('docker',['compose','--project-name',state.project,'--env-file',envFile,'-f',join(root,'deploy/compose.yaml'),'-f',override,...args],options);
const kubectl=(args:string[],options:Parameters<typeof run>[2]={})=>run(join(bin,'kubectl'),['--kubeconfig',kubeconfig,'--cache-dir',join(stateDir,'kube-cache'),'--context','kind-'+state.project,...args],options);
const helm=(args:string[],options:Parameters<typeof run>[2]={})=>run(join(bin,'helm'),['--kubeconfig',kubeconfig,'--kube-context','kind-'+state.project,...args],options);
function ownedNode(){
  const raw=run('docker',['inspect',node],{capture:true,allowFailure:true});if(!raw)return null;
  const info=JSON.parse(raw)[0] as {Config:{Labels:Record<string,string>};State:{Running:boolean};NetworkSettings:{Networks:Record<string,{IPAddress:string}>}};
  if(info.Config.Labels['io.x-k8s.kind.cluster']!==state.project)throw new Error('Refusing a cluster node not owned by this installation');
  return info;
}
function composeExists(){return existsSync(envFile)&&existsSync(override);}
function summary(){
  console.log(`\nOpenCrawl development workspace: ${state.origin}\nAirbyte: http://localhost:${state.airbytePort}\nPrivate login details: ${join(stateDir,'login.txt')}\nLast startup check: ${state.startedAt||state.verifiedAt||'not yet started'}\nOptional demo ingestion check: ${state.verifiedAt||'not run (./dev/up demo)'}\nStop without deleting data: ./dev/up stop\nDelete this development installation: ./dev/up reset --yes`);
}
if(action==='status'){
  if(composeExists())compose(['ps']);
  console.log(`Airbyte cluster: ${ownedNode()?.State.Running?'running':'stopped or absent'}`);summary();
}else if(action==='stop'){
  if(composeExists())compose(['stop']);if(ownedNode()?.State.Running)run('docker',['stop',node]);console.log('Stopped this development installation; all data is retained.');
}else if(action==='reset'){
  if(!process.argv.includes('--yes'))throw new Error('reset --yes permanently deletes this clone’s development accounts, imported data and Airbyte cluster');
  if(ownedNode())run(join(bin,'kind'),['delete','cluster','--name',state.project,'--kubeconfig',kubeconfig]);
  if(composeExists())compose(['down','--volumes']);
  // Airbyte's database owns files as container UIDs. Delete only this clone's
  // bind-mounted data using a short-lived container, before removing ownership state.
  const dataDir=join(stateDir,'airbyte-data');
  if(existsSync(dataDir)){
    if(lstatSync(dataDir).isSymbolicLink())throw new Error('Refusing symlinked Airbyte data');
    run('docker',['run','--rm','--network','none','--user','0:0','--entrypoint','node','--mount',`type=bind,source=${dataDir},target=/owned-data`,'node:24.22.2-bookworm-slim','-e',"const fs=require('node:fs');for(const entry of fs.readdirSync('/owned-data'))fs.rmSync('/owned-data/'+entry,{recursive:true,force:true});"]);
  }
  cleanup();rmSync(stateDir,{recursive:true});console.log('Deleted only this clone’s development installation.');
}else{
  await up();
}

async function download(name:string,pin:Pin){
  mkdirSync(bin,{recursive:true,mode:0o700});const destination=join(bin,name);
  if(existsSync(destination)){
    if(lstatSync(destination).isSymbolicLink())throw new Error('Refusing symlinked dev tool');
    if(!pin.member&&createHash('sha256').update(readFileSync(destination)).digest('hex')!==pin.sha256)throw new Error(`Pinned ${name} checksum changed; remove only that dev tool and retry`);
    return destination;
  }
  const archive=destination+'.download';console.log(`Downloading pinned ${name}...`);
  run('curl',['--fail','--silent','--show-error','--location','--retry','3',pin.url,'-o',archive]);
  if(createHash('sha256').update(readFileSync(archive)).digest('hex')!==pin.sha256){rmSync(archive);throw new Error(`${name} download checksum mismatch`);}
  if(pin.member){run('tar',['-xzf',archive,'-C',bin,pin.member]);renameSync(join(bin,pin.member),destination);rmSync(join(bin,dirname(pin.member)),{recursive:true});rmSync(archive);}else renameSync(archive,destination);
  chmodSync(destination,0o700);return destination;
}
async function freePort(p:number){await new Promise<void>((resolve,reject)=>{const server=createServer();server.once('error',()=>reject(new Error(`Loopback port ${p} is already in use; choose OPENCRAWL_DEV_PORT and OPENCRAWL_DEV_AIRBYTE_PORT before first run`)));server.listen(p,'127.0.0.1',()=>server.close(()=>resolve()));});}
async function until<T>(label:string,operation:()=>Promise<T|false>,minutes=10):Promise<T>{
  const end=Date.now()+minutes*60_000;let last='';
  while(Date.now()<end){try{const value=await operation();if(value!==false)return value;}catch(error){last=(error as Error).message;}
    console.log(`Waiting for ${label}...`);await delay(5000);}
  throw new Error(`${label} did not become ready${last?': '+last:''}`);
}
function ip(service:string){
  const id=compose(['ps','-q',service],{capture:true}).trim();if(!id)throw new Error(`${service} container is missing`);
  const info=JSON.parse(run('docker',['inspect',id],{capture:true}))[0] as {Config:{Labels:Record<string,string>};NetworkSettings:{Networks:Record<string,{IPAddress:string}>}};
  if(info.Config.Labels['com.docker.compose.project']!==state.project)throw new Error('Unexpected Compose resource owner');
  const address=info.NetworkSettings.Networks[state.project+'_default']?.IPAddress;
  if(!address||!/^\d+\.\d+\.\d+\.\d+$/.test(address))throw new Error(`Missing ${service} address`);return address;
}
function writeCompose(airbyteAddress='127.0.0.1',s3Address='s3',workspaceId=state.workspaceId||'00000000-0000-0000-0000-000000000000'){
  const connectorFile=join(stateDir,'connectors.env');
  if(!existsSync(connectorFile))privateFile(connectorFile,'# Optional credentials for real integrations. Restart with ./dev/up after editing.\n# COMPOSIO_API_KEY=\n# SLACK_CLIENT_ID=\n# SLACK_CLIENT_SECRET=\n# GITHUB_APP=\n');
  if(lstatSync(connectorFile).isSymbolicLink())throw new Error('Refusing symlinked connector configuration');
  const supplied=parseEnv(readFileSync(connectorFile,'utf8'));
  const connectorEnv=Object.fromEntries(['COMPOSIO_API_KEY','COMPOSIO_BASE_URL','SLACK_CLIENT_ID','SLACK_CLIENT_SECRET','GITHUB_APP','AIRBYTE_GITHUB_REPOSITORY','AIRBYTE_GITHUB_TAG','OPENCRAWL_AIRBYTE_APP_URL'].filter(key=>supplied[key]).map(key=>[key,supplied[key]!]));
  const env={COMPOSE_PROJECT_NAME:state.project,OPENCRAWL_IMAGE_TAG:state.project,OPENCRAWL_URL:state.origin,OPENCRAWL_ORGANIZATION_ID:state.organization,
    OPENCRAWL_AUTH_SECRET:state.authSecret,OPENCRAWL_SETUP_TOKEN:state.setupToken,OPENCRAWL_CONNECTOR_KEY:state.connectorKey,
    OPENCRAWL_S3_ACCESS_KEY_ID:state.s3Key,OPENCRAWL_S3_SECRET_ACCESS_KEY:state.s3Secret,OPENCRAWL_TEMPORAL_PASSWORD:state.temporalPassword,
    OPENCRAWL_AIRBYTE_S3_ENDPOINT:`http://${s3Address}:8333`,OPENCRAWL_APP_PORT:String(state.port),OPENCRAWL_APP_BIND:'127.0.0.1',OPENCRAWL_S3_BIND:'127.0.0.1',OPENCRAWL_S3_PORT:'0',
    AIRBYTE_URL:`http://${airbyteAddress}:30080`,AIRBYTE_CLIENT_ID:state.airbyteClientId,AIRBYTE_CLIENT_SECRET:state.airbyteClientSecret,AIRBYTE_WORKSPACE_ID:workspaceId,...connectorEnv};
  privateFile(envFile,Object.entries(env).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n');
  // Only additive dev composition. The normal images, env contract, data volumes,
  // workers and production behavior come from deploy/compose.yaml unchanged.
  privateFile(override,{services:{
    app:{environment:{REVISION:run('git',['rev-parse','HEAD'],{capture:true}).trim()}},
    fixture:{image:'node:24.22.2-bookworm-slim',command:['node','--disable-warning=ExperimentalWarning','/fixture.mts'],volumes:[`${join(root,'dev/fixture.mts')}:/fixture.mts:ro`],restart:'unless-stopped',healthcheck:{test:['CMD','node','-e',"fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],interval:'5s',timeout:'5s',retries:12}},
  }});
}
async function up(){
  const docker=JSON.parse(run('docker',['info','--format','{{json .}}'],{capture:true})) as {MemTotal:number;NCPU:number};
  if(docker.MemTotal<12*1024**3||docker.NCPU<4)throw new Error('Allocate at least 4 CPUs and 16 GiB RAM to Docker for the full dev stack');
  const disk=statfsSync(root);if(!state.startedAt&&!state.verifiedAt&&disk.bavail*disk.bsize<40*1024**3)throw new Error('At least 40 GiB free disk is required for the initial images and build');
  await download('kind',pins.kind);await download('kubectl',pins.kubectl);await download('helm',pins.helm);
  const chart=await download('airbyte.tgz',pins.airbyte);
  const existing=ownedNode();
  if(!existing){await freePort(state.airbytePort);await freePort(state.port);}
  writeCompose();
  console.log('Starting the normal storage and workflow dependencies...');
  compose(['up','-d','--wait','--wait-timeout','600','s3','opensearch','temporal','fixture']);
  console.log('Building the shared product runtime and React console...');compose(['build','app']);
  if(!existing){
    mkdirSync(join(stateDir,'airbyte-data'),{recursive:true,mode:0o700});
    privateFile(join(stateDir,'kind.json'),{kind:'Cluster',apiVersion:'kind.x-k8s.io/v1alpha4',networking:{apiServerAddress:'127.0.0.1'},nodes:[{role:'control-plane',image:pins.kindNode,
      extraMounts:[{hostPath:join(stateDir,'airbyte-data'),containerPath:'/var/local-path-provisioner'}],
      extraPortMappings:[{containerPort:30080,hostPort:state.airbytePort,listenAddress:'127.0.0.1',protocol:'TCP'}]}]});
    run(join(bin,'kind'),['create','cluster','--name',state.project,'--kubeconfig',kubeconfig,'--config',join(stateDir,'kind.json'),'--wait','5m']);
  }else if(!existing.State.Running){run('docker',['start',node]);}
  await until('private Kubernetes control plane',async()=>kubectl(
    ['wait','--for=condition=Ready',`node/${node}`,'--timeout=10s','--request-timeout=15s'],
    {capture:true,allowFailure:true}).includes('condition met'),5);
  if(!ownedNode()!.NetworkSettings.Networks[state.project+'_default'])run('docker',['network','connect',state.project+'_default',node]);
  const airbyteIp=ownedNode()!.NetworkSettings.Networks[state.project+'_default'].IPAddress;
  if(!/^\d+\.\d+\.\d+\.\d+$/.test(airbyteIp))throw new Error('Missing private Airbyte address');
  const values={global:{airbyteUrl:`http://localhost:${state.airbytePort}`,auth:{enabled:true,instanceAdmin:{password:state.airbytePassword,clientId:state.airbyteClientId,clientSecret:state.airbyteClientSecret},security:{cookieSecureSetting:false}},
    database:{password:state.airbyteDbPassword},
    tracking:{enabled:false,strategy:'logging'},
    env_vars:{AIRBYTE_INSTALLATION_ID:state.project},storage:{type:'minio',minio:{accessKeyId:'opencrawldev',secretAccessKey:state.airbyteStorageSecret}},
    workloads:{resources:{useConnectorResourceDefaults:false,
      mainContainer:{cpu:{request:'0',limit:'2'},memory:{request:'0',limit:'2Gi'}},
      check:{cpu:{request:'0'},memory:{request:'0'}},discover:{cpu:{request:'0'},memory:{request:'0'}},sidecar:{cpu:{request:'0'},memory:{request:'0'}}}}},
    server:{service:{type:'NodePort',port:8001,nodePort:30080},env_vars:{JOB_RESOURCE_VARIANT_OVERRIDE:'lowresource'}},
    connectorBuilderServer:{enabled:false},postgresql:{postgresqlPassword:state.airbyteDbPassword,storage:{volumeClaimValue:'5Gi'}},
    minio:{rootUser:'opencrawldev',rootPassword:state.airbyteStorageSecret,storage:{volumeClaimValue:'5Gi'},resources:{requests:{cpu:'100m',memory:'256Mi'},limits:{memory:'1Gi'}}}};
  privateFile(join(stateDir,'airbyte-values.json'),values);
  const configHash=createHash('sha256').update(JSON.stringify({chart:pins.airbyte,values})).digest('hex');
  if(!state.airbyteInstalled||state.airbyteConfigHash!==configHash){
    console.log('Installing pinned Airbyte in this clone’s private development cluster (first run can take 20 minutes)...');
    helm(['upgrade','--install','airbyte',chart,'--namespace','airbyte','--create-namespace','--values',join(stateDir,'airbyte-values.json'),'--wait','--timeout','20m']);
    state.airbyteInstalled=true;state.airbyteConfigHash=configHash;save();
  }
  // Airbyte 2.4's baked CDK catalog ends at major 4 (upstream issue #84928).
  // Bootstrap only our dedicated pinned cluster; never an operator's Airbyte.
  const cdk=pins.declarative;
  if(!/^7\.\d+\.\d+$/.test(cdk.version)||!/^sha256:[a-f0-9]{64}$/.test(cdk.imageSha))throw new Error('Invalid pinned declarative runtime');
  await until('Airbyte catalog database',async()=>kubectl(
    ['-n','airbyte','exec','-i','airbyte-db-0','--','psql','-U','airbyte','-d','db-airbyte','-v','ON_ERROR_STOP=1'],{capture:true,allowFailure:true,input:
      `INSERT INTO declarative_manifest_image_version (major_version,image_version,created_at,updated_at,image_sha) VALUES (7,'${cdk.version}',now(),now(),'${cdk.imageSha}') ON CONFLICT (major_version) DO NOTHING; SELECT 'CDK_READY';\n`}).includes('CDK_READY'),5);
  const airbyteUrl=`http://127.0.0.1:${state.airbytePort}`;
  const accessToken=await until('authenticated Airbyte API',async()=>{
    const r=await fetch(airbyteUrl+'/api/public/v1/applications/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_id:state.airbyteClientId,client_secret:state.airbyteClientSecret,'grant-type':'client_credentials'}),signal:AbortSignal.timeout(10000)});
    if(!r.ok)return false;const body=await r.json() as {access_token?:string};return body.access_token||false;
  });
  const api=async(method:string,path:string,body?:unknown)=>{
    const r=await fetch(airbyteUrl+'/api/public/v1'+path,{method,headers:{authorization:`Bearer ${accessToken}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
    if(!r.ok)throw new Error(`Airbyte ${method} ${path} returned ${r.status}`);return await r.json() as {workspaceId?:string;data?:Array<{workspaceId:string;name:string}>};
  };
  if(!state.workspaceId){
    const matches=(await api('GET','/workspaces?limit=100')).data?.filter(w=>w.name===state.project)||[];
    if(matches.length>1)throw new Error('Ambiguous development Airbyte workspace');
    state.workspaceId=matches[0]?.workspaceId||(await api('POST','/workspaces',{name:state.project})).workspaceId;
    if(!state.workspaceId)throw new Error('Airbyte returned no workspace ID');save();
  }
  writeCompose(airbyteIp,ip('s3'));
  console.log('Starting the normal authenticated application and indexing worker...');compose(['up','-d','--wait','--wait-timeout','600','app','worker']);
  const credentials={format:1,project:state.project,origin:state.origin,connectOrigin:'http://app:8092',organization:state.organization,email:state.email,password:state.password,setupToken:state.setupToken,fixtureUrl:`http://${ip('fixture')}:8080`};
  const seedDir=join(stateDir,'seed');mkdirSync(seedDir,{recursive:true,mode:0o700});
  privateFile(join(seedDir,'seed-input.json'),credentials);
  console.log(action==='demo'?'Loading demo data and verifying real Airbyte → S3 → Temporal → OpenSearch ingestion...':'Creating the local account and preserving first-run onboarding...');
  compose(['run','--rm','--no-deps','--user','root','--volume',`${join(root,'dev')}:/opencrawl/dev:ro`,'--volume',`${seedDir}:/dev-state`,'app','node','--disable-warning=ExperimentalWarning',action==='demo'?'dev/seed.mts':'dev/bootstrap.mts']);
  if(action==='demo'){
    privateFile(join(stateDir,'verification.json'),JSON.parse(readFileSync(join(seedDir,'verification.json'),'utf8')));
    state.verifiedAt=new Date().toISOString();
  }
  state.startedAt=new Date().toISOString();save();
  privateFile(join(stateDir,'login.txt'),`Development only\nURL: ${state.origin}\nEmail: ${state.email}\nPassword: ${state.password}\nAirbyte URL: http://localhost:${state.airbytePort}\nAirbyte password: ${state.airbytePassword}\n`);
  summary();
  console.log(`\nSign in to ${state.origin}\nEmail: ${state.email}\nPassword: ${state.password}\n\nThese local development credentials are also saved in .opencrawl-dev/login.txt.`);
}
