import {sessionClient} from '../dist/src/sessions/temporal/client.mjs';
import {digest} from '../dist/src/sessions/ingest.mjs';
const {client,connection}=await sessionClient({address:process.env.TEMPORAL_ADDRESS,namespace:process.env.TEMPORAL_NAMESPACE});
const sourceId=process.env.OPENCRAWL_ORGANIZATION_ID
  ?'sessions-'+process.env.OPENCRAWL_ORGANIZATION_ID+'-v1'
  :process.env.OPENCRAWL_SESSION_SOURCE_ID||'self-hosted-sessions-v1';
try{await client.schedule.getHandle('sessions-'+digest(sourceId)).trigger();}
finally{await connection.close();}
