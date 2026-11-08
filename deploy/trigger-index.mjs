import {sessionClient} from '../dist/src/sessions/temporal/client.mjs';
import {digest} from '../dist/src/sessions/ingest.mjs';
const {client,connection}=await sessionClient({address:process.env.TEMPORAL_ADDRESS,namespace:process.env.TEMPORAL_NAMESPACE});
try{await client.schedule.getHandle('sessions-'+digest('self-hosted-sessions-v1')).trigger();}
finally{await connection.close();}
