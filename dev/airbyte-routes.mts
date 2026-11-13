import type {IntegrationRegistry} from '../dist/src/integrations/ports.mjs';
import type {createAirbyteTransport} from '../dist/src/integrations/airbyte.mjs';

const routes={app:{name:'opencrawl-app',port:8092},s3:{name:'opencrawl-storage',port:8333},fixture:{name:'opencrawl-fixture',port:8080}} as const;
export type RouteAddresses=Partial<Record<keyof typeof routes,string>>;
export const routeUrl=(key:keyof typeof routes)=>`http://${routes[key].name}.airbyte.svc.cluster.local:${routes[key].port}`;
export function routeManifest(addresses:RouteAddresses){
  return {apiVersion:'v1',kind:'List',items:Object.entries(addresses).flatMap(([key,address])=>{
    if(!/^\d+\.\d+\.\d+\.\d+$/.test(address))throw new Error('Invalid owned development service address');
    const {name,port}=routes[key as keyof typeof routes];
    return [
      {apiVersion:'v1',kind:'Service',metadata:{name,namespace:'airbyte'},spec:{ports:[{name:'http',port,targetPort:port,protocol:'TCP'}]}},
      {apiVersion:'discovery.k8s.io/v1',kind:'EndpointSlice',metadata:{name,namespace:'airbyte',labels:{'kubernetes.io/service-name':name}},addressType:'IPv4',ports:[{name:'http',port,protocol:'TCP'}],endpoints:[{addresses:[address]}]},
    ];
  })};
}
interface Resource {workspaceId:string;destinationId?:string;sourceId?:string;configuration:Record<string,unknown>}
/** Only this installation's registered S3 destinations and built-in demo source.
 * Provider credentials, other source settings and foreign resources are untouched. */
export async function refreshDevelopmentRoutes({registry,transport,organizationId,workspaceId,bucket}:{registry:IntegrationRegistry;transport:Pick<ReturnType<typeof createAirbyteTransport>,'request'>;organizationId:string;workspaceId:string;bucket:string}){
  const updates:Array<{path:string;field:string;value:string}>=[];
  const denied=()=>new Error('Development Airbyte route ownership mismatch');
  for(const record of await registry.listTenant(organizationId)){
    if(['disconnecting','disconnected'].includes(record.status)||!record.airbyte?.destinationId)continue;
    if(record.tenantId!==organizationId||record.environment!=='selfhost'||record.airbyteWorkspaceId!==workspaceId||record.airbyteLandingMode!=='operator-owned'||record.s3Bucket!==bucket||!record.s3Prefix?.startsWith('raw/v1/source='+record.provider+'/')||!record.s3Prefix.endsWith('/connection='+record.integrationId)||record.s3Prefix.split('/').some(part=>part==='..'))throw denied();
    const path='/destinations/'+encodeURIComponent(record.airbyte.destinationId);
    const destination=await transport.request<Resource>('GET',path);
    if(destination.workspaceId!==workspaceId||destination.destinationId!==record.airbyte.destinationId||destination.configuration.s3_bucket_name!==bucket||destination.configuration.s3_bucket_path!==record.s3Prefix)throw denied();
    if(destination.configuration.s3_endpoint!==routeUrl('s3'))updates.push({path,field:'s3_endpoint',value:routeUrl('s3')});
    if(record.provider==='granola'&&record.account==='Synthetic development sample — not a Granola account'&&record.airbyte.sourceId){
      const path='/sources/'+encodeURIComponent(record.airbyte.sourceId),source=await transport.request<Resource>('GET',path);
      if(source.workspaceId!==workspaceId||source.sourceId!==record.airbyte.sourceId||typeof source.configuration.base_url!=='string'||!(source.configuration.base_url===routeUrl('fixture')||/^http:\/\/\d+\.\d+\.\d+\.\d+:8080$/.test(source.configuration.base_url)))throw denied();
      if(source.configuration.base_url!==routeUrl('fixture'))updates.push({path,field:'base_url',value:routeUrl('fixture')});
    }
  }
  // Validate the whole ownership plan before any mutation. PATCH changes only
  // the endpoint and preserves the connector's credentials and other settings.
  for(const {path,field,value} of updates){
    await transport.request('PATCH',path,{configuration:{[field]:value}},8*60_000);
    const verified=await transport.request<Resource>('GET',path);
    if(verified.workspaceId!==workspaceId||verified.configuration[field]!==value)throw new Error('Development Airbyte route update did not verify');
  }
  return {routesRefreshed:updates.length};
}
