import {statSync,realpathSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {commandForSelf} from '../capture/runtime.ts';
import {commandForBinary,PACKAGE,read,stable,target,version} from '../distribution.ts';

/** A packaged runtime and its native executable must generate the same guide. */
export function setupCommandForSelf():string[]{
 const command=commandForSelf();
 if(!stable(version))return command;
 // A managed entry may be a wrapper carrying installation-specific settings;
 // keep its exact spelling even when it happens to equal process.execPath.
 const managed=commandForBinary('');
 if(managed)return [managed];
 // On Windows, native execution can retain an 8.3 path while Bun's JS argv
 // resolves its long spelling. Only native realpath expands both consistently.
 const executablePath=(file:string)=>{if(process.platform==='win32')try{return realpathSync.native(file);}catch{}return file;};
 if(command.length===1)return [executablePath(command[0])];
 const runtime=command[1];
 if(!runtime||basename(runtime)!=='opencrawl.js'||basename(dirname(runtime))!=='runtime')return command;
 const root=dirname(dirname(runtime)),pkg=read(join(root,'package.json'));
 if(pkg?.version!==version)return command;
 const name=pkg.name===PACKAGE?'opencrawl.exe':pkg.name===PACKAGE+'-'+target()?process.platform==='win32'?'opencrawl.exe':'opencrawl':null;
 if(!name)return command;
 const executable=join(root,'bin',name);
 try{if(statSync(executable).isFile())return [executablePath(executable)];}catch{}
 return command;
}

// Preserve the managed launcher: it may carry a private installation's environment.
// Windows handoffs use PowerShell; POSIX handoffs work in sh, bash and zsh.
export function formatSetupCommand(args:string[],command=setupCommandForSelf(),platform=process.platform):string{
 const literal=(value:string)=>"'"+value.replaceAll("'",platform==='win32'?"''":"'\\''")+"'";
 const safe=platform==='win32'?/^[A-Za-z0-9_./:-]+$/:/^[A-Za-z0-9_@%+=:,./-]+$/;
 const words=[...command,...args].map((value,index)=>platform==='win32'&&index===0?literal(value):safe.test(value)?value:literal(value));
 return (platform==='win32'?'& ':'')+words.join(' ');
}
