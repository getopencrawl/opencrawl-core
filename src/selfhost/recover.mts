import {createLocalIdentity} from '../identity/better-auth.mjs';
import {selfhostSettings} from './settings.mjs';

// Explicit operator command. Use stdin so the password never appears in argv.
const email=process.argv[2];
if(!email)throw new Error('Usage: node dist/src/selfhost/recover.mjs account@example.com < password-file');
const chunks:Buffer[]=[];let size=0;
for await(const chunk of process.stdin){size+=chunk.length;if(size>512)throw new Error('Password input too long');chunks.push(Buffer.from(chunk));}
const password=Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/,'');
const settings=selfhostSettings(),identity=await createLocalIdentity({url:settings.url,secret:settings.authSecret,databasePath:settings.identityPath,organizationId:settings.organizationId});
try{await identity.ready();await identity.recoverPassword(email,password);console.log('Password changed. Previous browser sessions and OAuth grants were revoked.');}
finally{identity.close();}
