/** Run with the same trusted environment/identity as the self-host receiver. */
import {auditSessionEventSource} from './ingest.mjs';
import {sessionStorage} from './storage.mjs';

try {
 const args=process.argv.slice(2);
 if(args.length)throw new Error('Legacy audits are read-only; use identity-migration.mjs to import PostgreSQL state');
 const {store,prefix}=sessionStorage();
 const tenantId=process.env.OPENCRAWL_ORGANIZATION_ID||process.env.OPENCRAWL_TENANT_ID,userId=process.env.OPENCRAWL_USER_ID;
 if(!tenantId||!userId)throw new Error('An explicit organization and user are required');
 const principal={tenantId,userId};
 const result=await auditSessionEventSource({store,prefix,principal});
 process.stdout.write(JSON.stringify(result)+'\n');
 if(result.conflicts)process.exitCode=1;
} catch {
 // Provider errors and malformed raw JSON can contain tenant content/keys.
 process.stderr.write('Session identity audit failed; no successful audit recorded. Check scoped storage access, source integrity and documented limits.\n');
 process.exitCode=1;
}
