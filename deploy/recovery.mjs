import {createReadStream,readFileSync,existsSync,mkdirSync,openSync,closeSync,renameSync,fsyncSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,relative} from 'node:path';
import {docker,privateFile,root} from './installation.mjs';

export async function digest(path){const h=createHash('sha256');for await(const c of createReadStream(path))h.update(c);return h.digest('hex');}
export function snapshot(installation,containers) {
  const {project}=installation,services={},volumes={},stores=[];
  for(const container of containers) {
    const name=container.Config.Labels['com.docker.compose.service'];
    if(!name||services[name])throw new Error('Expected one container per full-application service');
    const mounts=[];
    for(const mount of container.Mounts) {
      if(mount.Type==='volume') {
        let store=stores.find(v=>v.name===mount.Name);
        if(!store) {
          const info=JSON.parse(docker(['volume','inspect',mount.Name]))[0];
          if(info.Labels?.['com.docker.compose.project']!==project)throw new Error('Cannot back up a volume owned outside this installation');
          store={name:mount.Name,key:'store'+stores.length};stores.push(store);volumes[store.key]={name:mount.Name};
        }
        mounts.push({type:'volume',source:store.key,target:mount.Destination,read_only:!mount.RW});
      } else if(mount.Type==='bind') {
        if(mount.RW)throw new Error('Writable bind mounts require a separately reviewed backup before upgrading');
        mounts.push({type:'bind',source:mount.Source,target:mount.Destination,read_only:true});
      } else throw new Error('Unsupported persistent mount type');
    }
    services[name]={image:container.Image,command:container.Config.Cmd,entrypoint:container.Config.Entrypoint,
      environment:container.Config.Env.map(value=>value.replaceAll('$',()=> '$$')),user:container.Config.User,working_dir:container.Config.WorkingDir,
      restart:container.HostConfig.RestartPolicy.Name||'no',volumes:mounts,
      ports:Object.entries(container.HostConfig.PortBindings||{}).flatMap(([target,bindings])=>(bindings||[]).map(b=>({target:Number(target.split('/')[0]),published:b.HostPort,host_ip:b.HostIp||'0.0.0.0',protocol:target.split('/')[1]}))),
      ...(container.Config.Healthcheck?{healthcheck:{test:container.Config.Healthcheck.Test,...Object.fromEntries([['Interval','interval'],['Timeout','timeout'],['StartPeriod','start_period']].filter(([source])=>container.Config.Healthcheck[source]).map(([source,key])=>[key,container.Config.Healthcheck[source]+'ns'])),...(container.Config.Healthcheck.Retries?{retries:container.Config.Healthcheck.Retries}:{})}}:{})};
  }
  // Preserve readiness ordering as well as images. In particular, SQLite
  // deployments depend on the one-shot authenticated object-store check.
  for(const container of containers) {
    const name=container.Config.Labels['com.docker.compose.service'];
    const encoded=container.Config.Labels['com.docker.compose.depends_on'];
    if(encoded) {
      services[name].depends_on=Object.fromEntries(encoded.split(',').map(value=>{
        const [dependency,condition]=value.split(':');
        if(!services[dependency]||!['service_started','service_healthy','service_completed_successfully'].includes(condition))throw new Error('Cannot preserve an unknown service dependency during recovery');
        return [dependency,{condition}];
      }));
    }
  }
  // Older Compose versions did not retain the dependency label. These are the
  // full application's stable dependency relationships, not a generic importer.
  const dependency=name=>({condition:services[name].healthcheck?'service_healthy':'service_started'});
  if(services.temporal&&!services.temporal.depends_on)services.temporal.depends_on={'temporal-db':dependency('temporal-db')};
  for(const name of ['storage-ready','database-ready'])if(services[name]&&!services[name].depends_on){const target=name==='storage-ready'?'s3':'temporal-db';services[name].depends_on={[target]:dependency(target)};}
  if(services.app&&!services.app.depends_on)services.app.depends_on=Object.fromEntries(['app-db','database-ready','storage-ready','s3','opensearch'].filter(name=>services[name]).map(name=>[name,name.endsWith('-ready')?{condition:'service_completed_successfully'}:dependency(name)]));
  if(services.worker&&!services.worker.depends_on)services.worker.depends_on={app:dependency('app'),...(services.temporal?{temporal:dependency('temporal')}:{})};
  if(!services.app||!services.worker||!services['temporal-db'])throw new Error('Upgrade requires the full application installation (app, worker and temporal-db)');
  return {format:2,project,kind:installation.kind,createdAt:new Date().toISOString(),stores,compose:{name:project,services,volumes},
    configurations:installation.configuration.map(path=>({path:relative(root,path),content:readFileSync(path,'utf8')})),
    images:[...new Set(containers.map(c=>c.Image))]};
}
export async function saveRecovery(directory,snapshot) {
  // The caller has already stopped every recorded writer. Never replace a
  // complete backup on retry, even if migration has partially changed storage.
  if(existsSync(join(directory,'manifest.json')))return verifyRecovery(directory);
  mkdirSync(directory,{recursive:true,mode:0o700});
  const saved=join(directory,'snapshot.json');
  if(existsSync(saved)&&readFileSync(saved,'utf8')!==JSON.stringify(snapshot,null,2)+'\n')throw new Error('Recovery snapshot changed while backup was incomplete');
  privateFile(saved,snapshot);
  const helper=snapshot.compose.services.app.image;
  const mounts=snapshot.stores.flatMap(s=>['--mount',`type=volume,source=${s.name},target=/stores/${s.key},readonly`]);
  function archive(name,args){
    const partial=join(directory,name+'.partial'),fd=openSync(partial,'w',0o600);
    try{docker(args,{stdio:['ignore',fd,'inherit']});fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(partial,join(directory,name));
  }
  archive('stores.tgz',['run','--rm','--network','none','--user','0:0',...mounts,'--entrypoint','tar',helper,'-czf','-','-C','/stores','.']);
  // Image IDs in the snapshot must remain recoverable after image pruning.
  archive('images.tar',['image','save',...snapshot.images]);
  const files={};for(const name of ['snapshot.json','stores.tgz','images.tar'])files[name]=await digest(join(directory,name));
  privateFile(join(directory,'manifest.json'),{format:2,files,project:snapshot.project,createdAt:new Date().toISOString()});
  return verifyRecovery(directory);
}
export async function verifyRecovery(directory) {
  const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
  if(manifest.format!==2)throw new Error('Unsupported recovery format');
  for(const name of ['snapshot.json','stores.tgz','images.tar'])if(await digest(join(directory,name))!==manifest.files[name])throw new Error('Recovery checksum mismatch: '+name);
  return JSON.parse(readFileSync(join(directory,'snapshot.json'),'utf8'));
}
