import {join,dirname} from 'node:path';
import {atomicFile,configDir} from './session.ts';

export const quote=(s:string)=>process.platform==='win32'?'"'+s.replace(/%/g,'%%').replace(/"/g,'""')+'"':"'"+s.replace(/'/g,"'\\''")+"'";
export function hookRunner(area:string,command:string[]){
  const file=join(configDir(),area,process.platform==='win32'?'runner.cmd':'runner.sh');
  const script=process.platform==='win32'
    ?'@echo off\r\nset "OPENCRAWL_CONFIG_HOME='+dirname(configDir()).replace(/%/g,'%%')+'"\r\n'+command.map(quote).join(' ')+' %*\r\n'
    :'#!/bin/sh\nexport OPENCRAWL_CONFIG_HOME='+quote(dirname(configDir()))+'\nexec '+command.map(quote).join(' ')+' "$@"\n';
  return {file,script,command:(process.platform==='win32'?'':'exec /bin/sh ')+quote(file),write:()=>atomicFile(file,script)};
}
