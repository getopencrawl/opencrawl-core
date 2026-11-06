// Migration only. New collection never installs or requires an OS service.
import {existsSync,unlinkSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {configDir} from '../session.ts';
const service='com.getopencrawl.capture';
export function removeLegacyService(home=homedir()) {
  // Custom/test profiles must not stop another installation's service.
  const owns=(file:string)=>{try{return existsSync(file)&&readFileSync(file,'utf8').includes(dirname(configDir()));}catch{return false;}};
  if(process.platform==='darwin'&&owns(join(home,'Library/LaunchAgents',service+'.plist'))){
    spawnSync('launchctl',['bootout','gui/'+process.getuid!()+'/'+service],{stdio:'ignore',timeout:2000});
    try{unlinkSync(join(home,'Library/LaunchAgents',service+'.plist'));}catch{}
  } else if(process.platform==='linux'&&owns(join(home,'.config/systemd/user',service+'.service'))){
    spawnSync('systemctl',['--user','disable','--now',service+'.timer'],{stdio:'ignore',timeout:2000});
    for(const ext of ['service','timer'])try{unlinkSync(join(home,'.config/systemd/user',service+'.'+ext));}catch{}
  }
}
