import {accessSync,constants,readdirSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import type {LocalPluginClient} from './published-plugins.ts';

export const executable=(path:string)=>{
 try{accessSync(path,constants.X_OK);return statSync(path).isFile();}catch{return false;}
};
function subdirectories(root:string,pattern:RegExp){
 try{return readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&pattern.test(entry.name)).map(entry=>entry.name);}
 catch{return [];}
}

type DesktopOptions={home?:string;env?:NodeJS.ProcessEnv;platform?:NodeJS.Platform;applicationDirs?:string[];which?:(name:string)=>string|null};
function applicationRoots(home:string,platform:NodeJS.Platform){
 return platform==='darwin'?[join(home,'Applications'),'/Applications']:['/usr/lib'];
}
export function hasClaudeDesktop({home=homedir(),platform=process.platform,applicationDirs=applicationRoots(home,platform)}:DesktopOptions={}){
 if(platform!=='darwin'&&platform!=='linux')return false;
 const app=platform==='darwin'?'Claude.app/Contents/MacOS/Claude':'claude-desktop/claude-desktop';
 return applicationDirs.some(root=>executable(join(root,app)));
}

// Cursor 2.5 introduced editor plugins. cursor-agent uses a separate dated release series.
export const cursorEditorMinimum='2.5.0';
function cursorEditors(platform:NodeJS.Platform,roots:string[],launcher:string|null){
 const mac=platform==='darwin';
 const installs=roots.flatMap(root=>mac?[join(root,'Cursor.app','Contents')]:[join(root,'cursor'),join(root,'Cursor')]);
 if(launcher){
  try{
   const path=realpathSync(launcher);
   const appDir=dirname(path);
   if(basename(appDir)==='bin'){
    const parent=dirname(appDir);
    installs.push(basename(parent)==='app'?dirname(dirname(parent)):parent);
   }else installs.push(mac?dirname(appDir):appDir);
  }catch{/* Ignore a broken shell launcher. */}
 }
 return [...new Set(installs)].flatMap(root=>{
  const binary=join(root,mac?'MacOS/Cursor':'cursor');
  if(!executable(binary))return [];
  try{
   const product=JSON.parse(readFileSync(join(root,mac?'Resources':'resources','app/product.json'),'utf8'));
   return product.applicationName==='cursor'&&typeof product.version==='string'&&Bun.semver.satisfies(product.version,'>='+cursorEditorMinimum)?[binary]:[];
  }catch{return [];}
 });
}

/** Desktop Code and Work use the same native plugin profiles as their terminal counterparts. */
export function desktopExecutables(client:LocalPluginClient,{home=homedir(),env=process.env,platform=process.platform,which=name=>Bun.which(name,{PATH:env.PATH}),
 applicationDirs=client==='cursor'&&platform==='linux'?['/usr/share','/opt','/usr/lib',join(home,'.local/share')]:applicationRoots(home,platform)}:DesktopOptions={}):string[]{
 if(client==='cursor'&&(platform==='darwin'||platform==='linux'))return cursorEditors(platform,applicationDirs,which('cursor'));
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
