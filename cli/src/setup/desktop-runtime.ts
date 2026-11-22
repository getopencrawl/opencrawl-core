import {accessSync,constants,readdirSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {LocalPluginClient} from './published-plugins.ts';

const executable=(path:string)=>{
 try{accessSync(path,constants.X_OK);return statSync(path).isFile();}catch{return false;}
};
function subdirectories(root:string,pattern:RegExp){
 try{return readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&pattern.test(entry.name)).map(entry=>entry.name);}
 catch{return [];}
}

type DesktopOptions={home?:string;env?:NodeJS.ProcessEnv;platform?:NodeJS.Platform;applicationDirs?:string[]};
function applicationRoots(home:string,platform:NodeJS.Platform){
 return platform==='darwin'?[join(home,'Applications'),'/Applications']:['/usr/lib'];
}
export function hasClaudeDesktop({home=homedir(),platform=process.platform,applicationDirs=applicationRoots(home,platform)}:DesktopOptions={}){
 if(platform!=='darwin'&&platform!=='linux')return false;
 const app=platform==='darwin'?'Claude.app/Contents/MacOS/Claude':'claude-desktop/claude-desktop';
 return applicationDirs.some(root=>executable(join(root,app)));
}

/** Desktop Code and Work use the same native plugin profiles as their terminal counterparts. */
export function desktopExecutables(client:LocalPluginClient,{home=homedir(),env=process.env,platform=process.platform,
 applicationDirs=applicationRoots(home,platform)}:DesktopOptions={}):string[]{
 if(client==='codex'&&platform==='linux'){
  return applicationDirs.map(root=>join(root,'chatgpt','resources','codex')).filter(executable);
 }
 if(client==='codex'&&platform==='darwin'){
  return applicationDirs.flatMap(root=>['ChatGPT.app','Codex.app'].flatMap(app=>{
   const resources=join(root,app,'Contents','Resources');
   return [join(resources,'codex-cli','CodexCLI.app','Contents','MacOS','codex'),join(resources,'codex')];
  })).filter(executable);
 }
 if(client!=='claude-code'||!hasClaudeDesktop({home,platform,applicationDirs}))return [];
 const data=platform==='darwin'?join(home,'Library','Application Support'):env.XDG_CONFIG_HOME||join(home,'.config');
 const engines=join(data,'Claude','claude-code');
 const native=platform==='darwin'?join('claude.app','Contents','MacOS','claude'):'claude';
 return subdirectories(engines,/^\d+\.\d+\.\d+$/).sort((a,b)=>Bun.semver.order(b,a)).flatMap(version=>{
  const root=join(engines,version);
  return [...subdirectories(root,/^[a-f0-9]{12}$/).sort().map(build=>join(root,build,native)),join(root,native)];
 }).filter(executable);
}
