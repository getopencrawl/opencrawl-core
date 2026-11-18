import {spawn} from 'node:child_process';

type Run = (command:string,args:string[])=>Promise<number>;
const run:Run=(command,args)=>new Promise((resolve,reject)=>{
 const child=spawn(command,args,{stdio:'inherit',env:process.env});
 child.once('error',reject);child.once('exit',code=>resolve(code??1));
});

type ClaudeSetupOptions={server:string;prompt:string;needsLogin:boolean;returnToSetup?:boolean};

/** Native Claude owns its OAuth tokens. The CLI waits for its browser callback. */
export async function launchClaudeSetup(claude:string,{server,prompt,needsLogin,returnToSetup}:ClaudeSetupOptions,execute:Run=run,notify:(message:string)=>void=message=>console.error(message)){
 if(needsLogin){
  notify('Connect Claude Code: approve access in the browser. Setup continues automatically.');
  const code=await execute(claude,['mcp','login',server]);
  if(code!==0)return code;
 }
 notify('Opening a Claude Code session in this terminal to check the connection.');
 const task=returnToSetup
  ? prompt+' Once this client is verified, end your reply with “Press Ctrl+C to close Claude Code and return to OpenCrawl setup. If Claude asks you to confirm, press Ctrl+C again.”'
  : prompt;
 const code=await execute(claude,[task]);
 // The TUI rechecks verification after the session closes, including an early Ctrl+C.
 return returnToSetup&&code===130?0:code;
}
