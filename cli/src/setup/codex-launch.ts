/** Native Codex owns OAuth and hook review; setup never edits its trust state. */
export async function launchCodexSetup(codex:string,{server,prompt,needsLogin}:{server:string;prompt:string;needsLogin:boolean},execute:(command:string,args:string[])=>Promise<number>,notify:(message:string)=>void){
 if(needsLogin){
  notify('Connect Codex: approve access in the browser. Setup continues automatically.');
  const code=await execute(codex,['mcp','login',server]);
  if(code!==0)return code;
 }
 notify('Opening Codex to verify setup. Review any native hook approvals. Your choices are saved.');
 return execute(codex,[prompt]);
}
