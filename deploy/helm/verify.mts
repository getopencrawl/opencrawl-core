#!/usr/bin/env node
// Read-only application probes by default; --exercise writes synthetic data.
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {configuration,applicationName} from './install.mts';
const {values}=parseArgs({options:{config:{type:'string'},exercise:{type:'boolean'},existing:{type:'boolean'},'deny-marker':{type:'string'}}});
if(!values.config)throw Error('--config is required');
if((values.existing||values['deny-marker'])&&!values.exercise)throw Error('--existing and --deny-marker require --exercise');
const c=configuration(JSON.parse(readFileSync(values.config,'utf8')));
const kube=(args:string[],input?:unknown)=>{const r=spawnSync(process.env.KUBECTL||'kubectl',['--context',c.context,'-n',c.namespace,...args],{encoding:'utf8',input:input===undefined?undefined:JSON.stringify(input),maxBuffer:10*1024*1024});if(r.status!==0)throw Error('kubectl '+args[0]+' failed; inspect conformance Job and pod events');return r.stdout;};
const apply=(value:unknown)=>kube(['apply','-f','-'],value);
const name=c.release+'-conformance',secret=name+'-account';
if(values.exercise&&!kube(['get','secret',secret,'--ignore-not-found','-o','name'])){
  if(values.existing)throw Error('Saved conformance account Secret is missing; refusing to recreate the fixture');
  apply({apiVersion:'v1',kind:'Secret',metadata:{name:secret},type:'Opaque',stringData:{CONFORMANCE_EMAIL:'helm-conformance@example.invalid',CONFORMANCE_PASSWORD:randomBytes(32).toString('hex'),CONFORMANCE_MARKER:'helmcheck'+randomBytes(12).toString('hex')}});
}
const runtime=join(dirname(fileURLToPath(import.meta.url)),'runtime');
const files=['probe.mts','postgres-connect.mts'];
const data=Object.fromEntries(files.map(file=>[file,readFileSync(join(runtime,file),'utf8')]));
// Individual mounts keep Node's relative imports rooted at the runtime directory.
const mounts=files.map(file=>({name:'conformance',mountPath:'/opencrawl/deploy/helm/runtime/'+file,subPath:file,readOnly:true}));
apply({apiVersion:'v1',kind:'ConfigMap',metadata:{name},data});
const appName=applicationName(c);
const app=JSON.parse(kube(['get','deployment',appName+'-app','-o','json']));
const spec=structuredClone(app.spec.template.spec),container=spec.containers[0];
delete spec.initContainers;spec.restartPolicy='Never';
// The probe uses the HTTP API. Attaching the app's RWO disk can block scheduling.
spec.volumes=spec.volumes.filter((volume:{name:string})=>volume.name!=='shared-files');
container.volumeMounts=container.volumeMounts.filter((mount:{name:string})=>mount.name!=='shared-files');
spec.containers=[{name:'conformance',image:container.image,imagePullPolicy:container.imagePullPolicy,command:['node','/opencrawl/deploy/helm/runtime/probe.mts'],envFrom:[...container.envFrom,...(values.exercise?[{secretRef:{name:secret}}]:[])],env:[...(container.env||[]),{name:'CONFORMANCE_EXERCISE',value:String(!!values.exercise)},{name:'CONFORMANCE_EXISTING',value:String(!!values.existing)},{name:'CONFORMANCE_DENY_MARKER',value:values['deny-marker']||''},{name:'CONFORMANCE_APP_URL',value:`http://${appName}:${c.application.service?.port||8092}`}],securityContext:container.securityContext,volumeMounts:[...container.volumeMounts,...mounts],resources:{requests:{cpu:'100m',memory:'256Mi'},limits:{memory:'1Gi'}}}];
spec.volumes.push({name:'conformance',configMap:{name}});
kube(['delete','job',name,'--ignore-not-found','--wait=true']);
apply({apiVersion:'batch/v1',kind:'Job',metadata:{name,labels:{'app.kubernetes.io/instance':c.release,'app.kubernetes.io/component':'conformance'}},spec:{backoffLimit:0,activeDeadlineSeconds:900,ttlSecondsAfterFinished:86400,template:{spec}}});
// kubectl logs can return immediately while a newly scheduled container is creating.
// Accept Running or Terminated so a fast successful probe cannot be missed.
let pod:string|undefined;
for(let attempt=0;attempt<180;attempt++){
  const pods=JSON.parse(kube(['get','pods','-l','job-name='+name,'-o','json'])).items;
  const started=pods.find((p:any)=>{const state=p.status?.containerStatuses?.[0]?.state;return state?.running||state?.terminated;});
  if(started){pod=started.metadata.name;break;}
  await delay(1000);
}
if(!pod)throw Error('Conformance container did not start within 180 seconds; inspect pod events and image access');
// Logs carry structured diagnostic results and no credential material.
const logs=spawnSync(process.env.KUBECTL||'kubectl',['--context',c.context,'-n',c.namespace,'logs','pod/'+pod,'--follow','--pod-running-timeout=180s'],{stdio:'inherit'});
if(logs.status!==0)process.exit(1);
try{kube(['wait','--for=condition=complete','job/'+name,'--timeout=15s']);}catch{process.exitCode=1;}
