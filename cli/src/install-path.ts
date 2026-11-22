import {appendFileSync,existsSync,mkdirSync,readFileSync,realpathSync,statSync,symlinkSync} from 'node:fs';
import {homedir,userInfo} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {CliError} from './oauth.ts';

const quoteSh=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
const quoteFish=(value:string)=>"'"+value.replaceAll('\\','\\\\').replaceAll("'","\\'")+"'";

function resolvesTo(entry:string){
 const current=Bun.which('opencrawl',{PATH:process.env.PATH});
 return !!current&&realpathSync(current)===realpathSync(entry);
}

function configureWindowsPath(directory:string){
 if(/[;\r\n]/.test(directory))throw new CliError('INSTALL_PATH_INVALID','The install directory must be a single PATH entry.');
 const powershell=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const script=`
$ErrorActionPreference='Stop'
$dir=$env:OPENCRAWL_PATH_ENTRY
$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
 $raw=[string]$key.GetValue('Path','','DoNotExpandEnvironmentNames')
 $entries=@($raw -split ';' | Where-Object { $_ })
 if ($entries.Count -gt 0 -and [Environment]::ExpandEnvironmentVariables($entries[0]).TrimEnd('\\') -eq $dir.TrimEnd('\\')) { exit 0 }
 $remaining=@($entries | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ne $dir.TrimEnd('\\') })
 $updated=(@($dir)+$remaining) -join ';'
 $kind=if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
 [Environment]::SetEnvironmentVariable('Path',$updated,'User')
 # Preserve expandable entries after .NET broadcasts the environment change.
 $key.SetValue('Path',$updated,$kind)
} finally { $key.Dispose() }`;
 const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,OPENCRAWL_PATH_ENTRY:directory},encoding:'utf8',windowsHide:true});
 if(result.status!==0)throw new CliError('SHELL_PATH_REQUIRED','Could not update the Windows user PATH. Add '+directory+' in Environment Variables, then reopen the terminal.');
 return 'Added '+directory+' to your Windows user PATH. Open a new terminal to use opencrawl.';
}

/** Only the explicit installer configures the shell. Updates keep the stable launcher. */
export function configureShellPath(entry:string){
 if(process.platform==='win32')return configureWindowsPath(dirname(resolve(entry)));
 if(resolvesTo(entry))return 'The opencrawl command is on PATH.';
 const home=homedir(),directory=dirname(resolve(entry));
 if(/[:\r\n]/.test(directory))throw new CliError('INSTALL_PATH_INVALID','The install directory must be a single PATH entry.');
 // A link in an existing personal bin also works in the calling terminal.
 const pathEntries=(process.env.PATH??'').split(':');
 if(!Bun.which('opencrawl',{PATH:process.env.PATH})){
  for(const bin of [join(home,'bin'),join(home,'.local','bin')]){
   if(bin===directory||!pathEntries.includes(bin)||!existsSync(bin))continue;
   const stat=statSync(bin);
   if(!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o022)!==0)continue;
   try{symlinkSync(resolve(entry),join(bin,'opencrawl'));}
   catch(error){if(!['EEXIST','EACCES','EPERM','EROFS'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
   if(resolvesTo(entry))return 'The opencrawl command is on PATH.';
  }
 }

 const shell=basename(process.env.SHELL||userInfo().shell||'sh'),quoted=quoteSh(directory);
 let files:string[];
 let command='export PATH='+quoted+'"${PATH:+:$PATH}"';
 let line='case "$PATH" in '+quoted+'|'+quoted+':*) ;; *) '+command+' ;; esac';
 switch(shell){
  case 'zsh':
   files=['.zshrc','.zprofile'].map(file=>join(process.env.ZDOTDIR||home,file));
   break;
  case 'bash':{
   const login=['.bash_profile','.bash_login','.profile'].map(name=>join(home,name)).find(existsSync)??join(home,'.profile');
   files=[join(home,'.bashrc'),login];
   break;
  }
  case 'fish':
   files=[join(process.env.XDG_CONFIG_HOME||join(home,'.config'),'fish','conf.d','opencrawl-path.fish')];
   command='set -gx PATH '+quoteFish(directory)+' $PATH';
   line='if test "$PATH[1]" != '+quoteFish(directory)+'; '+command+'; end';
   break;
  case 'sh':case 'dash':case 'ksh':
   files=[join(home,'.profile')];
   break;
  default:
   throw new CliError('SHELL_PATH_REQUIRED','OpenCrawl was installed at '+entry+'. Add '+directory+' to PATH in your '+shell+' startup configuration.');
 }
 for(const file of files){
  const content=existsSync(file)?readFileSync(file,'utf8'):'';
  if(content.split('\n').includes(line))continue;
  mkdirSync(dirname(file),{recursive:true});
  appendFileSync(file,'\n# OpenCrawl CLI\n'+line+'\n',{mode:0o600});
 }
 return 'Configured PATH in '+files.join(' and ')+'. Open a new terminal or run this in the current one:\n'+command;
}
