/** Run with the same trusted environment/identity as the self-host receiver. */
import {auditSessionEventSource} from './ingest.mjs';
import {standaloneStorage} from './standalone.mjs';

try {
 const args=process.argv.slice(2);
 if(args.length>1||args.some(arg=>arg!=='--initialize'))throw new Error('Invalid audit arguments');
 const {store,prefix}=standaloneStorage();
 const principal={tenantId:process.env.OPENCRAWL_TENANT_ID||'self-hosted',userId:process.env.OPENCRAWL_USER_ID||'owner'};
 const result=await auditSessionEventSource({store,prefix,principal,initialize:args.includes('--initialize')});
 process.stdout.write(JSON.stringify(result)+'\n');
 if(result.conflicts)process.exitCode=1;
} catch {
 // Provider errors and malformed raw JSON can contain tenant content/keys.
 process.stderr.write('Session identity audit failed; no successful audit recorded. Check scoped storage access, source integrity and documented limits.\n');
 process.exitCode=1;
}
