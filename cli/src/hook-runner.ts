import {join,dirname} from 'node:path';
import {atomicFile,configDir} from './session.ts';

export const quote=(s:string)=>process.platform==='win32'?'"'+s.replace(/%/g,'%%').replace(/"/g,'""')+'"':"'"+s.replace(/'/g,"'\\''")+"'";
export function hookRunner(area:string,command:string[]){
  const file=join(configDir(),area,process.platform==='win32'?'runner.cmd':'runner.sh');
  const script=process.platform==='win32'
    ?'@echo off\r\nset "OPENCRAWL_CONFIG_HOME='+dirname(configDir()).replace(/%/g,'%%')+'"\r\n'+command.map(quote).join(' ')+' %*\r\n'
    :'#!/bin/sh\nexport OPENCRAWL_CONFIG_HOME='+quote(dirname(configDir()))+'\nexec '+command.map(quote).join(' ')+' "$@"\n';
  const shellCommand=(process.platform==='win32'?'':'exec /bin/sh ')+quote(file);
  // Claude defaults to Git Bash or PowerShell on Windows; select PowerShell
  // explicitly for .cmd runners. Codex's Windows hook shell is COMSPEC/cmd.exe.
  const invocation=(client:string)=>process.platform==='win32'&&client==='claude-code'
    ?{command:"& '"+file.replace(/'/g,"''")+"'",shell:'powershell' as const}:{command:shellCommand};
  return {file,script,command:shellCommand,invocation,write:()=>atomicFile(file,script)};
}
