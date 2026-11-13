import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {root,docker,run} from './installation.mjs';
import {verifyRecovery} from './recovery.mjs';
import {routeManifest} from '../dev/airbyte-routes.mts';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--backup')throw new Error('Usage: resume-airbyte.mjs --backup /private/recovery-directory');
const saved=await verifyRecovery(resolve(args[1]));
if(saved.kind!=='dev'||!saved.airbyte)throw new Error('This recovery point has no owned development Airbyte node');
const node=JSON.parse(docker(['inspect',saved.airbyte.id]))[0];
if(node.Config.Labels['io.x-k8s.kind.cluster']!==saved.project)throw new Error('Retained Airbyte cluster ownership mismatch');
if(!node.State.Running)docker(['start',saved.airbyte.id]);
const kubectl=join(root,'.opencrawl-dev/bin/kubectl');
const config=['--kubeconfig',join(root,'.opencrawl-dev/kubeconfig'),'--context','kind-'+saved.project];
for(let attempt=0;;attempt++){
 try{run(kubectl,[...config,'wait','--for=condition=Ready','node/'+saved.project+'-control-plane','--timeout=10s','--request-timeout=15s']);break;}
 catch(error){if(attempt>=59)throw error;await delay(3000);}
}
const addresses=Object.fromEntries(['app','s3','fixture'].flatMap(service=>{
 const address=saved.compose.services[service]?.networks?.default?.ipv4_address;return address?[[service,address]]:[];
}));
if(!addresses.app||!addresses.s3)throw new Error('Saved application routes are incomplete');
run(kubectl,[...config,'apply','-f','-'],{input:JSON.stringify(routeManifest(addresses))});
console.log(JSON.stringify({airbyte:'resumed',routes:'restored'}));
