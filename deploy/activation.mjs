/** The command waits for real current-scope Temporal completions. A successful
 * process exit alone is insufficient evidence for an upgrade completion. */
export function activateConnectors(current){
 const output=current.compose(['run','--rm','--no-deps','app','node','dist/src/selfhost/activate.mjs']);
 let report;try{report=JSON.parse(output);}catch{throw new Error('Connector activation did not return a verified completion report');}
 const result=report?.connectorCatchup;
 if(!result||result.completed!==true||typeof result.required!=='boolean'||!Number.isSafeInteger(result.connections)||result.connections<0||
   result.required&&(!/^[a-f0-9]{64}$/.test(result.activationId)||!/^[a-f0-9]{64}$/.test(result.manifest)||!/^[-a-f0-9]{36}$/.test(result.migrationId))||
   !result.required&&result.connections!==0)throw new Error('Connector activation remains incomplete');
 return result;
}

/** Container inspection is refreshed while holding the installation lock. The
 * immutable image label is set by the supported build from its checked-out Git
 * target; runtime environment variables cannot impersonate that provenance. */
export function verifyStartup(inventory,{project,target,images,expected}){
 const writers=inventory.filter(c=>['app','worker'].includes(c.Config?.Labels?.['com.docker.compose.service']));
 if(writers.filter(c=>c.Config.Labels['com.docker.compose.service']==='app').length!==1||!writers.some(c=>c.Config.Labels['com.docker.compose.service']==='worker')||new Set(writers.map(c=>c.Id)).size!==writers.length||writers.some(c=>c.Config.Labels['com.docker.compose.project']!==project||!Array.isArray(images)||images.filter(image=>image.Id===c.Image&&image.Config?.Labels?.['org.opencontainers.image.revision']===target).length!==1||c.State?.Running!==true||c.State?.Health?.Status!=='healthy'||!/^sha256:[a-f0-9]{64}$/.test(c.Image))||writers.some(c=>c.Image!==writers[0].Image))throw new Error('Current healthy app and worker images do not prove this source target; run the supported startup first');
 const result=writers.map(c=>({service:c.Config.Labels['com.docker.compose.service'],id:c.Id,image:c.Image})).sort((a,b)=>a.service.localeCompare(b.service)||a.id.localeCompare(b.id));
 if(expected&&JSON.stringify(result)!==JSON.stringify(expected))throw new Error('Application or worker changed during connector activation; resume startup');
 return result;
}
