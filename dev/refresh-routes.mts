import {createAirbyteTransport} from '../dist/src/integrations/airbyte.mjs';
import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {refreshDevelopmentRoutes} from './airbyte-routes.mts';
const required=(key:string)=>{const value=process.env[key];if(!value)throw new Error(key+' is required');return value;};
const organizationId=required('OPENCRAWL_ORGANIZATION_ID');
const registry=createSingleOrganizationRegistry({path:required('OPENCRAWL_REGISTRY_PATH'),organizationId});
try{
 const transport=createAirbyteTransport({url:required('AIRBYTE_URL'),clientId:required('AIRBYTE_CLIENT_ID'),clientSecret:required('AIRBYTE_CLIENT_SECRET')});
 console.log(JSON.stringify(await refreshDevelopmentRoutes({registry,transport,organizationId,workspaceId:required('AIRBYTE_WORKSPACE_ID'),bucket:required('OPENCRAWL_LANDING_S3_BUCKET')})));
}finally{registry.close();}
