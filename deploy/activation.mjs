/** Container inspection is refreshed while holding the installation lock. The
 * immutable image label is set by the supported build from its checked-out Git
 * target; runtime environment variables cannot impersonate that provenance. */
export function verifyStartup(inventory,{project,target,images,expected}){
 const writers=inventory.filter(c=>['app','worker'].includes(c.Config?.Labels?.['com.docker.compose.service']));
 if(writers.filter(c=>c.Config.Labels['com.docker.compose.service']==='app').length!==1||!writers.some(c=>c.Config.Labels['com.docker.compose.service']==='worker')||new Set(writers.map(c=>c.Id)).size!==writers.length||writers.some(c=>c.Config.Labels['com.docker.compose.project']!==project||!Array.isArray(images)||images.filter(image=>image.Id===c.Image&&image.Config?.Labels?.['org.opencontainers.image.revision']===target).length!==1||c.State?.Running!==true||c.State?.Health?.Status!=='healthy'||!/^sha256:[a-f0-9]{64}$/.test(c.Image))||writers.some(c=>c.Image!==writers[0].Image))throw new Error('Current healthy app and worker images do not prove this source target; run the supported startup first');
 const result=writers.map(c=>({service:c.Config.Labels['com.docker.compose.service'],id:c.Id,image:c.Image})).sort((a,b)=>a.service.localeCompare(b.service)||a.id.localeCompare(b.id));
 if(expected&&JSON.stringify(result)!==JSON.stringify(expected))throw new Error('Application or worker changed during startup verification; resume startup');
 return result;
}
