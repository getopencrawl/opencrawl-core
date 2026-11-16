#!/usr/bin/env node
// Node 24+, kubectl and Helm. No application build or npm install is required.
import {readFileSync,writeFileSync,mkdirSync,existsSync,chmodSync,unlinkSync,cpSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';

export type Values=Record<string,any>;
const fail=(code:string,message:string):never=>{throw Object.assign(new Error(message),{code});};
const name=(v:unknown,label:string)=>{if(typeof v!=='string'||!/^[a-z][a-z0-9-]{0,29}$/.test(v))fail('INVALID_CONFIG',`${label} must be a lowercase Kubernetes name of at most 30 characters`);return v as string;};
const mode=(v:Values,label:string,optional=false)=>{if(!['bundled','external',...(optional?['disabled']:[])].includes(v.mode))fail('INVALID_CONFIG',`${label}.mode must select bundled or external${optional?' or disabled':''}`);};
const sql=(v:unknown,label:string)=>{if(typeof v!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(v))fail('INVALID_CONFIG',`${label} must be a SQL identifier`);};
const required=(value:unknown,label:string)=>{if(typeof value!=='string'||!value)fail('INVALID_CONFIG',`${label} is required`);return value as string;};
function merge(base:Values,extra:Values):Values {const out={...base};for(const [k,v] of Object.entries(extra)){if(['__proto__','prototype','constructor'].includes(k))fail('INVALID_CONFIG','Invalid configuration key');out[k]=v&&typeof v==='object'&&!Array.isArray(v)?merge(base[k]??{},v):v;}return out;}
export function configuration(input:Values):Values {
  for(const key of Object.keys(input))if(!['release','namespace','context','url','image','githubConnector','storageClass','postgresql','databases','temporal','opensearch','objectStorage','airbyte','application','infrastructure'].includes(key))fail('INVALID_CONFIG',`Unknown configuration key: ${key}`);
  const manifestPath=join(dirname(fileURLToPath(import.meta.url)),'release.json');
  const published=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,'utf8')):{};
  const c=merge({release:'opencrawl',namespace:'opencrawl',image:published.image||{repository:'ghcr.io/getopencrawl/opencrawl-core',tag:'',digest:''},githubConnector:published.githubConnector||{repository:'ghcr.io/getopencrawl/source-github',tag:''},storageClass:'',postgresql:{enabled:true},
    databases:{app:{mode:'bundled',name:'opencrawl',user:'opencrawl'},temporal:{mode:'bundled',name:'temporal',visibilityName:'temporal_visibility',user:'temporal'},airbyte:{mode:'bundled',name:'airbyte',temporalName:'airbyte_temporal',visibilityName:'airbyte_visibility',user:'airbyte'}},
    temporal:{mode:'bundled',namespace:'opencrawl',tls:{enabled:false}},opensearch:{mode:'bundled'},objectStorage:{mode:'bundled',bucket:'opencrawl',region:'us-east-1'},airbyte:{mode:'bundled',chartVersion:'2.4.0',values:{}},application:{},infrastructure:{}},input);
  name(c.release,'release');name(c.namespace,'namespace');required(c.context,'context');
  // An explicit tag overrides the kit's default digest; do not silently keep the old image.
  if(input.image?.tag&&!Object.hasOwn(input.image,'digest'))c.image.digest='';
  if(input.image?.tag&&!input.githubConnector)c.githubConnector={repository:'ghcr.io/getopencrawl/source-github',tag:input.image.tag};
  const url=new URL(required(c.url,'url'));if(url.origin!==c.url||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))fail('INVALID_CONFIG','url must be an HTTPS origin or local HTTP origin');
  if(!c.image.tag&&!c.image.digest)fail('INVALID_CONFIG','image.tag or image.digest must identify a published runtime');
  if(c.image.digest&&!/^sha256:[a-f0-9]{64}$/.test(c.image.digest))fail('INVALID_CONFIG','image.digest must be a SHA-256 digest');
  for(const k of ['temporal','opensearch','objectStorage','airbyte'])mode(c[k],k,k==='airbyte');
  c.githubConnector.tag||=c.image.tag;
  if(c.airbyte.mode!=='disabled')required(c.githubConnector.tag,'githubConnector.tag (or image.tag)');
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(c.temporal.namespace))fail('INVALID_CONFIG','Invalid Temporal namespace');
  for(const k of ['app',...(c.temporal.mode==='bundled'?['temporal']:[]),...(c.airbyte.mode==='bundled'?['airbyte']:[])]){
    const d=c.databases[k];mode(d,`databases.${k}`);
    if(d.mode==='bundled'){if(!c.postgresql.enabled)fail('INVALID_CONFIG',`databases.${k} requires bundled PostgreSQL or an external connection`);for(const field of ['name','user','visibilityName','temporalName'])if(d[field])sql(d[field],`databases.${k}.${field}`);}
    else {required(d.existingSecret,`databases.${k}.existingSecret`);if(k!=='app'){required(d.host,`databases.${k}.host`);sql(d.user,`databases.${k}.user`);sql(d.name,`databases.${k}.name`);}}
  }
  if(c.temporal.mode==='external')required(c.temporal.address,'temporal.address');
  if(typeof c.temporal.tls.enabled!=='boolean')fail('INVALID_CONFIG','temporal.tls.enabled must be a boolean');
  if((c.temporal.existingSecret||c.temporal.tls.existingSecret)&&!c.temporal.tls.enabled)fail('INVALID_CONFIG','Temporal credentials require TLS');
  if(Boolean(c.temporal.tls.certKey)!==Boolean(c.temporal.tls.keyKey))fail('INVALID_CONFIG','Temporal certificate and private key must be paired');
  if(c.airbyte.mode==='bundled'&&c.airbyte.chartVersion!=='2.4.0')fail('INVALID_CONFIG','This installer supports Airbyte chart 2.4.0; use external mode for another release');
  if(c.opensearch.mode==='external')required(c.opensearch.url,'opensearch.url');
  if(c.opensearch.index&&!/^[a-z][a-z0-9_-]{0,150}$/.test(c.opensearch.index))fail('INVALID_CONFIG','Invalid opensearch.index');
  if(c.objectStorage.mode==='external'){required(c.objectStorage.endpoint,'objectStorage.endpoint');required(c.objectStorage.bucket,'objectStorage.bucket');required(c.objectStorage.existingSecret,'objectStorage.existingSecret');}
  if(c.airbyte.mode==='external')for(const field of ['url','workspaceId','existingSecret'])required(c.airbyte[field],`airbyte.${field}`);
  return c;
}
function execute(command:string,args:string[],input?:string,optional=false):string {
  const r=spawnSync(command,args,{input,encoding:'utf8',maxBuffer:16*1024*1024,env:process.env});
  if(r.status!==0&&!optional)fail('COMMAND_FAILED',`${command} ${args.slice(0,2).join(' ')} failed: ${(r.stderr||r.error?.message||'').slice(-1800)}`);
  return r.status===0?r.stdout:'';
}
export function plan(c:Values){return {schemaVersion:1,release:c.release,namespace:c.namespace,context:c.context,steps:[
  {release:c.release+'-infra',chart:'opencrawl',components:{postgresql:c.postgresql.enabled,temporal:c.temporal.mode,opensearch:c.opensearch.mode,objectStorage:c.objectStorage.mode}},
  ...(c.airbyte.mode==='bundled'?[{release:c.release+'-airbyte',chart:`airbyte@${c.airbyte.chartVersion}`}]:[]),
  {release:c.release,chart:'opencrawl',components:{app:1,worker:1},image:c.image}],databases:Object.fromEntries(Object.entries(c.databases).map(([k,v])=>[k,(v as Values).mode])),automaticUpgrade:false};}

export function airbyteValues(c:Values,secretName:string,dbHost:string,storagePassword:string):Values {
  const d=c.databases.airbyte,dbSecret=d.mode==='bundled'?secretName:d.existingSecret;
  const jdbc='jdbc:postgresql://'+(d.mode==='bundled'?dbHost:d.host)+':'+(d.port||5432)+'/'+d.name+(d.tls?'?sslmode=verify-full'+(d.caPath?'&sslrootcert='+encodeURIComponent(d.caPath):'&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory'):'?sslmode=disable');
  return merge({global:{airbyteUrl:`http://${c.release}-airbyte-airbyte-server-svc:8001`,auth:{enabled:true,secretName:secretName,security:{cookieSecureSetting:false}},database:{jdbcUrl:jdbc,type:d.tls?'external':'internal',host:d.mode==='bundled'?dbHost:d.host,port:d.port||5432,name:d.name,user:d.user,secretName:dbSecret,passwordSecretKey:'DATABASE_PASSWORD',replica:{userSecretKey:'DATABASE_USER',passwordSecretKey:'DATABASE_PASSWORD'}},tracking:{enabled:false,strategy:'logging'},workloads:{resources:{useConnectorResourceDefaults:false,mainContainer:{cpu:{request:'100m',limit:'2'},memory:{request:'256Mi',limit:'2Gi'}},check:{cpu:{request:'100m'},memory:{request:'256Mi'}},discover:{cpu:{request:'100m'},memory:{request:'256Mi'}},sidecar:{cpu:{request:'100m'},memory:{request:'128Mi'}}}}},
      postgresql:{enabled:false},temporal:{secretName:dbSecret,database:{host:d.mode==='bundled'?dbHost:d.host,port:d.port||5432,user:d.user,passwordSecretKey:'DATABASE_PASSWORD'},env_vars:{DBNAME:d.temporalName,VISIBILITY_DBNAME:d.visibilityName,SKIP_DB_CREATE:'true',SQL_HOST_VERIFICATION:'true',SQL_HOST_NAME:d.mode==='bundled'?dbHost:d.host,...(d.caPath?{POSTGRES_TLS_CA_FILE:d.caPath,SQL_CA:d.caPath}:{})}},
      connectorBuilderServer:{enabled:false},server:{env_vars:{JOB_RESOURCE_VARIANT_OVERRIDE:'lowresource'}},minio:{rootUser:'opencrawl',rootPassword:storagePassword,storage:{volumeClaimValue:'5Gi'},resources:{requests:{cpu:'100m',memory:'256Mi'},limits:{memory:'1Gi'}}}},c.airbyte.values);
}

// A parent template supplies the JDBC URL missing from the pinned upstream values.
// Preserve upstream hooks and emit each environment variable exactly once.
export function prepareAirbyteChart(stateDir:string,archive:Uint8Array):string {
  if(createHash('sha256').update(archive).digest('hex')!=='ec25fcddc952dbef05183f426149553f78db0f7e61642c9d13c77e32c93433a3')fail('CHART_CHECKSUM','Airbyte chart checksum mismatch');
  const wrapper=join(stateDir,'airbyte-wrapper');
  cpSync(join(dirname(fileURLToPath(import.meta.url)),'airbyte-wrapper'),wrapper,{recursive:true});
  mkdirSync(join(wrapper,'charts'),{recursive:true});
  writeFileSync(join(wrapper,'charts/airbyte-2.4.0.tgz'),archive,{mode:0o600});
  return wrapper;
}

async function install(c:Values,stateDir:string,through='application'){
  const chart=join(dirname(fileURLToPath(import.meta.url)),'opencrawl');mkdirSync(stateDir,{recursive:true,mode:0o700});chmodSync(stateDir,0o700);
  const kube=(args:string[],input?:string,optional=false)=>execute(process.env.KUBECTL||'kubectl',['--context',c.context,'--namespace',c.namespace,...args],input,optional);
  const helm=(args:string[])=>execute(process.env.HELM||'helm',['--kube-context',c.context,...args]);
  const apply=(object:unknown)=>kube(['apply','-f','-'],JSON.stringify(object));
  const progress=(stage:string)=>console.log(JSON.stringify({schemaVersion:1,stage,status:'running'}));
  const values=(file:string,value:Values)=>{const p=join(stateDir,file);writeFileSync(p,JSON.stringify(value,null,2)+'\n',{mode:0o600});return p;};
  apply({apiVersion:'v1',kind:'Namespace',metadata:{name:c.namespace}});
  const secretName=c.release+'-credentials';
  let current=kube(['get','secret',secretName,'-o','json','--ignore-not-found']);
  let secrets:Record<string,string>;
  if(current)secrets=Object.fromEntries(Object.entries(JSON.parse(current).data??{}).map(([k,v])=>[k,Buffer.from(v as string,'base64').toString()]));
  else secrets={OPENCRAWL_ORGANIZATION_ID:'org_'+randomBytes(12).toString('hex'),OPENCRAWL_AUTH_SECRET:randomBytes(32).toString('hex'),OPENCRAWL_SETUP_TOKEN:randomBytes(32).toString('hex'),OPENCRAWL_CONNECTOR_KEY:randomBytes(32).toString('base64'),POSTGRES_PASSWORD:randomBytes(32).toString('hex'),APP_DATABASE_PASSWORD:randomBytes(32).toString('hex'),TEMPORAL_DATABASE_PASSWORD:randomBytes(32).toString('hex'),DATABASE_PASSWORD:randomBytes(32).toString('hex'),AWS_ACCESS_KEY_ID:'oc'+randomBytes(12).toString('hex'),AWS_SECRET_ACCESS_KEY:randomBytes(32).toString('hex'),AB_INSTANCE_ADMIN_PASSWORD:randomBytes(32).toString('hex'),AB_INSTANCE_ADMIN_CLIENT_ID:randomUUID(),AB_INSTANCE_ADMIN_CLIENT_SECRET:randomBytes(32).toString('hex')};
  const dbHost=c.release+'-infra-postgresql';
  // Bootstrap JWT is separate from the application's authentication secret.
  secrets.AB_JWT_SIGNATURE_SECRET??=randomBytes(32).toString('base64');
  secrets.DATABASE_USER=c.databases.airbyte.user;
  if(c.databases.app.mode==='bundled')secrets.OPENCRAWL_DATABASE_URL=`postgres://${c.databases.app.user}:${secrets.APP_DATABASE_PASSWORD}@${dbHost}:5432/${c.databases.app.name}`;
  const organization=required(secrets.OPENCRAWL_ORGANIZATION_ID,'saved organization');
  const binding={organization,bucket:c.objectStorage.bucket,prefix:c.objectStorage.prefix||`${organization}/capture/v1`,namespace:c.temporal.namespace,index:c.opensearch.index||`opencrawl-selfhost-realm-${createHash('sha256').update(organization).digest('hex')}-v1`};
  const bindingPath=join(stateDir,'binding.json');if(existsSync(bindingPath)&&JSON.stringify(JSON.parse(readFileSync(bindingPath,'utf8')))!==JSON.stringify(binding))fail('BINDING_CHANGED','Installation identity/storage/Temporal binding changed; perform a separately verified migration');
  values('binding.json',binding);
  apply({apiVersion:'v1',kind:'Secret',metadata:{name:secretName,namespace:c.namespace,labels:{'app.kubernetes.io/managed-by':'opencrawl-installer','app.kubernetes.io/instance':c.release}},type:'Opaque',stringData:secrets});
  const dbs:Values[]=[];
  if(c.databases.app.mode==='bundled')dbs.push({...c.databases.app,passwordKey:'APP_DATABASE_PASSWORD'});
  if(c.temporal.mode==='bundled'&&c.databases.temporal.mode==='bundled')for(const n of [c.databases.temporal.name,c.databases.temporal.visibilityName])dbs.push({name:n,user:c.databases.temporal.user,passwordKey:'TEMPORAL_DATABASE_PASSWORD'});
  if(c.airbyte.mode==='bundled'&&c.databases.airbyte.mode==='bundled')for(const n of [c.databases.airbyte.name,c.databases.airbyte.temporalName,c.databases.airbyte.visibilityName])dbs.push({name:n,user:c.databases.airbyte.user,passwordKey:'DATABASE_PASSWORD'});
  const infra=merge({runtime:{enabled:false},storageClass:c.storageClass,postgresql:{enabled:c.postgresql.enabled,existingSecret:secretName,databases:dbs.map(({name,user,passwordKey})=>({name,user,passwordKey}))},
    opensearch:{enabled:c.opensearch.mode==='bundled'},objectStorage:{enabled:c.objectStorage.mode==='bundled',existingSecret:secretName,bucket:c.objectStorage.bucket},
    temporal:{enabled:c.temporal.mode==='bundled',namespace:c.temporal.namespace,existingSecret:c.databases.temporal.mode==='bundled'?secretName:c.databases.temporal.existingSecret,database:{host:c.databases.temporal.mode==='bundled'?dbHost:c.databases.temporal.host,port:c.databases.temporal.port||5432,user:c.databases.temporal.user,name:c.databases.temporal.name,visibilityName:c.databases.temporal.visibilityName,tls:c.databases.temporal.tls??false,caPath:c.databases.temporal.caPath||''}}},c.infrastructure);
  progress('infrastructure');helm(['upgrade','--install',c.release+'-infra',chart,'-n',c.namespace,'-f',values('infrastructure.json',infra),'--wait','--timeout','15m']);
  if(through==='infrastructure')return;
  let workspaceId=c.airbyte.workspaceId;
  const airbyteUrl=c.airbyte.mode==='bundled'?`http://${c.release}-airbyte-airbyte-server-svc:8001`:c.airbyte.url;
  if(c.airbyte.mode==='bundled'){
    const d=c.databases.airbyte,dbSecret=d.mode==='bundled'?secretName:d.existingSecret;
    const airbyte=airbyteValues(c,secretName,dbHost,secrets.AWS_SECRET_ACCESS_KEY);
    // Upstream MinIO requires a value; this generated file is private and never emitted.
    progress('airbyte');const privateValues=values('airbyte.private.json',{airbyte});
    const airbyteChart=join(stateDir,'airbyte-2.4.0.tgz');
    try{
      const archive=existsSync(airbyteChart)?readFileSync(airbyteChart):Buffer.from(await (await fetch('https://airbytehq.github.io/charts/airbyte-2.4.0.tgz',{signal:AbortSignal.timeout(60000)})).arrayBuffer());
      const wrapper=prepareAirbyteChart(stateDir,archive);
      writeFileSync(airbyteChart,archive,{mode:0o600});
      helm(['upgrade','--install',c.release+'-airbyte',wrapper,'-n',c.namespace,'-f',privateValues,'--wait','--timeout','25m']);
    }finally{unlinkSync(privateValues);}
    // Catalog repair is scoped to the pinned bundled Airbyte release. External Airbyte is never changed.
    const bootstrapEnv=[{name:'PG_TLS_ENABLED',value:String(!!d.tls)},{name:'PG_TLS_CA_PATH',value:d.caPath||''},{name:'PGHOST',value:d.mode==='bundled'?dbHost:d.host},{name:'PGPORT',value:String(d.port||5432)},{name:'PGDATABASE',value:d.name},{name:'PGUSER',value:d.user},{name:'PGPASSWORD',valueFrom:{secretKeyRef:{name:dbSecret,key:'DATABASE_PASSWORD'}}},{name:'AIRBYTE_URL',value:airbyteUrl},{name:'AIRBYTE_WORKSPACE_NAME',value:c.release},{name:'AIRBYTE_CLIENT_ID',valueFrom:{secretKeyRef:{name:secretName,key:'AB_INSTANCE_ADMIN_CLIENT_ID'}}},{name:'AIRBYTE_CLIENT_SECRET',valueFrom:{secretKeyRef:{name:secretName,key:'AB_INSTANCE_ADMIN_CLIENT_SECRET'}}}];
    const jobName=c.release+'-airbyte-bootstrap';kube(['delete','job',jobName,'--ignore-not-found','--wait=true']);
    const code=`import pg from 'pg';import {readFileSync} from 'node:fs';const db=new pg.Client({ssl:process.env.PG_TLS_ENABLED==='true'?{rejectUnauthorized:true,...(process.env.PG_TLS_CA_PATH?{ca:readFileSync(process.env.PG_TLS_CA_PATH)}:{})}:false});await db.connect();try{await db.query(\"INSERT INTO declarative_manifest_image_version (major_version,image_version,created_at,updated_at,image_sha) VALUES (7,'7.45.1',now(),now(),'sha256:f98cd95b4263c30c76b23c67b9c43e817e4f6b000663081e91778748b50d32e1') ON CONFLICT (major_version) DO UPDATE SET image_version=EXCLUDED.image_version,image_sha=EXCLUDED.image_sha,updated_at=now()\");}finally{await db.end();}const url=process.env.AIRBYTE_URL; const r=await fetch(url+'/api/public/v1/applications/token',{redirect:'error',method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_id:process.env.AIRBYTE_CLIENT_ID,client_secret:process.env.AIRBYTE_CLIENT_SECRET,'grant-type':'client_credentials'})});if(!r.ok)throw Error('Airbyte authentication failed '+r.status);const {access_token}=await r.json();const headers={authorization:'Bearer '+access_token,'content-type':'application/json'};let list=await fetch(url+'/api/public/v1/workspaces?limit=100',{headers});if(!list.ok)throw Error('Workspace lookup failed');let matches=(await list.json()).data.filter(x=>x.name===process.env.AIRBYTE_WORKSPACE_NAME);if(matches.length>1)throw Error('Ambiguous workspace');let id=matches[0]?.workspaceId;if(!id){const r=await fetch(url+'/api/public/v1/workspaces',{method:'POST',headers,body:JSON.stringify({name:process.env.AIRBYTE_WORKSPACE_NAME})});if(!r.ok)throw Error('Workspace creation failed');id=(await r.json()).workspaceId;}if(!id)throw Error('Workspace ID absent');console.log(JSON.stringify({workspaceId:id}));`;
    apply({apiVersion:'batch/v1',kind:'Job',metadata:{name:jobName,namespace:c.namespace},spec:{backoffLimit:3,activeDeadlineSeconds:600,ttlSecondsAfterFinished:86400,template:{spec:{restartPolicy:'Never',automountServiceAccountToken:false,imagePullSecrets:c.application.imagePullSecrets||[],nodeSelector:c.application.nodeSelector||{},tolerations:c.application.tolerations||[],volumes:airbyte.airbyteBootloader?.extraVolumes||[],containers:[{name:'bootstrap',volumeMounts:[...(airbyte.airbyteBootloader?.extraVolumeMounts||[]),...(airbyte.global?.extraVolumeMounts||[])],image:c.image.digest?c.image.repository+'@'+c.image.digest:c.image.repository+':'+c.image.tag,command:['node','--input-type=module','-e',code],env:bootstrapEnv}]}}}});
    kube(['wait','--for=condition=complete','job/'+jobName,'--timeout=300s']);
    workspaceId=JSON.parse(kube(['logs','job/'+jobName]).trim().split('\n').at(-1)!).workspaceId;
  }
  if(through==='airbyte')return;
  const runtimeSecret=c.release+'-runtime-credentials';
  const runtimeKeys=['OPENCRAWL_ORGANIZATION_ID','OPENCRAWL_AUTH_SECRET','OPENCRAWL_SETUP_TOKEN','OPENCRAWL_CONNECTOR_KEY',...(c.databases.app.mode==='bundled'?['OPENCRAWL_DATABASE_URL']:[])];
  apply({apiVersion:'v1',kind:'Secret',metadata:{name:runtimeSecret,namespace:c.namespace,labels:{'app.kubernetes.io/instance':c.release}},type:'Opaque',stringData:Object.fromEntries(runtimeKeys.map(k=>[k,secrets[k]]))});
  const extraEnv:Values[]=[];const ref=(env:string,secret:string,key=env)=>extraEnv.push({name:env,valueFrom:{secretKeyRef:{name:secret,key}}});
  if(c.databases.app.mode==='external')ref('OPENCRAWL_DATABASE_URL',c.databases.app.existingSecret);
  const storageSecret=c.objectStorage.mode==='bundled'?secretName:c.objectStorage.existingSecret;
  ref('OPENCRAWL_LANDING_S3_ACCESS_KEY_ID',storageSecret,'AWS_ACCESS_KEY_ID');ref('OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY',storageSecret,'AWS_SECRET_ACCESS_KEY');
  if(c.opensearch.existingSecret){ref('OPENCRAWL_OPENSEARCH_USERNAME',c.opensearch.existingSecret);ref('OPENCRAWL_OPENSEARCH_PASSWORD',c.opensearch.existingSecret);}
  if(c.airbyte.mode!=='disabled'){const secret=c.airbyte.mode==='bundled'?secretName:c.airbyte.existingSecret;ref('AIRBYTE_CLIENT_ID',secret,c.airbyte.mode==='bundled'?'AB_INSTANCE_ADMIN_CLIENT_ID':'AIRBYTE_CLIENT_ID');ref('AIRBYTE_CLIENT_SECRET',secret,c.airbyte.mode==='bundled'?'AB_INSTANCE_ADMIN_CLIENT_SECRET':'AIRBYTE_CLIENT_SECRET');}
  if(c.temporal.existingSecret)ref('TEMPORAL_API_KEY',c.temporal.existingSecret);
  const extraVolumes:Values[]=[],extraVolumeMounts:Values[]=[];const tlsEnv:Values={TEMPORAL_TLS_ENABLED:String(c.temporal.tls.enabled)};
  if(c.temporal.tls.existingSecret){extraVolumes.push({name:'temporal-tls',secret:{secretName:c.temporal.tls.existingSecret}});extraVolumeMounts.push({name:'temporal-tls',mountPath:'/etc/opencrawl/temporal',readOnly:true});for(const [field,key] of [['TEMPORAL_TLS_CA_PATH','caKey'],['TEMPORAL_TLS_CERT_PATH','certKey'],['TEMPORAL_TLS_KEY_PATH','keyKey']])if(c.temporal.tls[key])tlsEnv[field]='/etc/opencrawl/temporal/'+c.temporal.tls[key];}
  if(c.temporal.tls.serverName)tlsEnv.TEMPORAL_TLS_SERVER_NAME=c.temporal.tls.serverName;
  const endpoint=c.objectStorage.mode==='bundled'?`http://${c.release}-infra-s3:8333`:c.objectStorage.endpoint;
  const app=merge({image:c.image,storageClass:c.storageClass,postgresql:{enabled:false},opensearch:{enabled:false},objectStorage:{enabled:false},temporal:{enabled:false},runtime:{enabled:true,existingSecret:runtimeSecret,extraEnv,extraVolumes,extraVolumeMounts,env:{OPENCRAWL_URL:c.url,OPENCRAWL_APP_STATE_NAMESPACE:organization,OPENCRAWL_LANDING_S3_BUCKET:c.objectStorage.bucket,OPENCRAWL_LANDING_S3_REGION:c.objectStorage.region,OPENCRAWL_LANDING_S3_ENDPOINT:endpoint,OPENCRAWL_LANDING_S3_PATH:binding.prefix,OPENCRAWL_AIRBYTE_ENABLED:String(c.airbyte.mode!=='disabled'),OPENCRAWL_AIRBYTE_S3_ENDPOINT:c.objectStorage.airbyteEndpoint||endpoint,OPENCRAWL_AIRBYTE_APP_URL:c.airbyte.appUrl||`http://${c.release}.${c.namespace}.svc.cluster.local:8092`,AIRBYTE_URL:airbyteUrl||'',AIRBYTE_WORKSPACE_ID:workspaceId||'',AIRBYTE_GITHUB_REPOSITORY:c.githubConnector.repository,AIRBYTE_GITHUB_TAG:c.githubConnector.tag,OPENCRAWL_OPENSEARCH_INDEX:binding.index,OPENCRAWL_OPENSEARCH_URL:c.opensearch.mode==='bundled'?`http://${c.release}-infra-opensearch:9200`:c.opensearch.url,TEMPORAL_ADDRESS:c.temporal.mode==='bundled'?`${c.release}-infra-temporal:7233`:c.temporal.address,TEMPORAL_NAMESPACE:c.temporal.namespace,...tlsEnv}}},c.application);
  progress('application');helm(['upgrade','--install',c.release,chart,'-n',c.namespace,'-f',values('application.json',app),'--wait','--timeout','15m']);
  const receipt={...plan(c),status:'installed',organization,workspaceId,installedAt:new Date().toISOString()};values('receipt.json',receipt);console.log(JSON.stringify(receipt));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{config:{type:'string'},apply:{type:'boolean'},'state-dir':{type:'string'},through:{type:'string',default:'application'}},strict:true});
  try{const c=configuration(JSON.parse(readFileSync(required(values.config,'--config'),'utf8')));if(!['infrastructure','airbyte','application'].includes(values.through!))fail('INVALID_CONFIG','Invalid --through stage');if(values.apply)await install(c,resolve(values['state-dir']||`.opencrawl-helm/${c.namespace}/${c.release}`),values.through);else console.log(JSON.stringify(plan(c),null,2));}
  catch(error){const e=error as Error & {code?:string};console.error(JSON.stringify({schemaVersion:1,status:'failed',code:e.code||'INSTALL_FAILED',message:e.message}));process.exitCode=1;}
}
