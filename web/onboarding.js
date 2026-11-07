void (async () => {
 const {deriveOnboarding,hasReceipt}=await import('./onboarding-state.js');
 const {requestJson}=await import('./http.js');
 const q=selector=>document.querySelector(selector);
 const screens=[...document.querySelectorAll('[data-screen]')];
 const copyState={},copyTimers={},snippetTimers=new Map();
 const titles={connect:'Connect your primary coding agent',mcp:'Complete MCP sign-in',verify:'Ask your agent to test the connection',session:'Start a new coding session'};
 const descriptions={connect:'Install the OpenCrawl CLI to start recording your coding agent sessions. Your agent will guide you through sign-in, then test the connection.',mcp:'Your CLI is signed in. Finish OpenCrawl’s MCP sign-in in your coding agent. Your agent will test the connection afterward.',verify:'MCP is connected, but we haven’t received a successful connection test. Paste this prompt into your agent to run it.',session:'Open a new session in your coding agent, then paste this small task. We’ll continue when its recording arrives.'};
 let step=null,polling=false,controller=null,mode='loading',status={},manualTarget=null;
 function hideAll(){screens.forEach(screen=>screen.hidden=true);q('#connection-error').hidden=true;q('#manual-copy').hidden=true;q('#onboarding-loading').hidden=true;q('#next-action').hidden=true;}
 function announce(text){if(q('#progress-announcement').textContent!==text)q('#progress-announcement').textContent=text;}
 function paint({focus=false}={}){
  const complete=deriveOnboarding(status).complete;
  hideAll();mode='step';
  const screen=q('[data-screen="connect"]');screen.hidden=false;
  screen.querySelector('.signal-checklist').hidden=false;
  const hasMcp=hasReceipt(status.mcp)||hasReceipt(status.mcpTest);
  const promptStep=complete?'connect':step;
  screen.querySelector('h1').textContent=complete?titles.connect:step==='connect'&&hasMcp?'Complete CLI sign-in':titles[step];
  screen.querySelector('.focus-description').textContent=complete?descriptions.connect:step==='connect'&&hasMcp?'MCP is connected. Complete CLI sign-in to enable session recording. Your agent can guide you through the browser approval.':descriptions[step];
  const model=q(`#${promptStep}-prompt`),button=screen.querySelector('.copy-prompt'),toggle=screen.querySelector('.prompt-toggle');
  button.dataset.step=promptStep;button.dataset.label=model.dataset.label;
  button.querySelector('span').textContent=copyState[promptStep]?'Copied':model.dataset.label;
  q('#connect-preview p').textContent=model.value;
  toggle.setAttribute('aria-label',`${toggle.getAttribute('aria-expanded')==='true'?'Hide':'Show'} ${promptStep==='connect'?'setup':promptStep==='mcp'?'MCP setup':promptStep==='verify'?'test':'task'} prompt`);
  q('#next-action').hidden=!complete;q('#next-step').hidden=!complete;
  if(focus)screen.querySelector('h1').focus({preventScroll:true});
 }
 function closeDisclosure(disclosure){
  if(!disclosure?.open)return;
  const summary=disclosure.querySelector(':scope > summary');
  const restoreFocus=disclosure.contains(document.activeElement)&&!summary.contains(document.activeElement);
  disclosure.open=false;
  if(restoreFocus)summary.focus({preventScroll:true});
 }
 function paintHistory(){
  const value=hasReceipt(status.history)?status.history.state:undefined;
  document.querySelectorAll('[data-history-instructions]').forEach(el=>el.hidden=value==='importing');
  document.querySelectorAll('[data-history-importing]').forEach(el=>el.hidden=value!=='importing');
 }
 async function refresh(){
  if(polling||document.hidden)return;
  polling=true;controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);
  const retry=q('#retry-status');retry.disabled=true;
  try{
   const {data}=await requestJson('/api/onboarding',{signal:controller.signal});status=data;paintHistory();
   document.querySelectorAll('[data-signal]').forEach(item=>{
    const signal=item.dataset.signal;
    const wasComplete=item.hasAttribute('data-complete');
    const historyState=hasReceipt(status.history)?status.history.state:undefined;
    const done=signal==='history'?['complete','received'].includes(historyState):hasReceipt(status[signal==='recording'?'session':signal])||(signal==='mcp'&&hasReceipt(status.mcpTest));
    const deferred=signal==='recording'?!done:signal==='history'?historyState!=='importing'&&!done:signal==='session'?!done&&!hasReceipt(status.mcpTest):signal==='mcpTest'&&!done&&!(hasReceipt(status.cli)&&hasReceipt(status.mcp));
    item.toggleAttribute('data-pending',deferred);item.toggleAttribute('data-complete',done);
    if(done&&!wasComplete)closeDisclosure(item.querySelector(':scope > details'));
    const labels={cli:['Waiting for CLI sign-in','CLI signed in'],mcp:['Waiting for MCP sign-in','MCP signed in'],mcpTest:['Waiting for agent to test connection','Connection test passed'],recording:['Enable session recording','Session recording enabled'],session:['Waiting for first session recording','First session recording received'],history:['Import past sessions','Import past sessions']};
    item.querySelector('.signal-label').textContent=labels[signal][done?1:0];
    const detail=item.querySelector('.signal-detail');
    if(signal==='history')detail.toggleAttribute('data-complete',done);
    if(signal==='history')detail.textContent={complete:'Imported',received:'Received',skipped:'Skipped',importing:'Importing'}[historyState]||(hasReceipt(status.session)?'Not started':'');
    if(detail){detail.hidden=!detail.textContent;item.toggleAttribute('data-detail',Boolean(detail.textContent));}
    item.querySelector('.signal-status').textContent=signal==='history'&&historyState==='skipped'?'Skipped':signal==='history'&&historyState==='importing'?'Importing':done?'Complete':deferred?'Pending':'Waiting';
   });
   const next=deriveOnboarding(data).step;
   const changed=next!==step;const contextChanged=next==='connect'&&mode==='step'&&(hasReceipt(data.mcp)||hasReceipt(data.mcpTest))!==q('[data-screen="connect"]').hasAttribute('data-mcp-seen');
   q('[data-screen="connect"]').toggleAttribute('data-mcp-seen',(hasReceipt(data.mcp)||hasReceipt(data.mcpTest)));const recovering=mode==='error';const first=step===null;
   step=next;
   // Preserve a manually selected copy fallback during unchanged polling.
   if(changed||contextChanged||recovering||mode==='loading'){
    paint({focus:recovering});
    if(!first)announce(next==='ready'?'All required checks passed. Next is available.':q('#connect-title').textContent);
   }
  }catch{
   if(mode!=='error'){
    const wasLoading=mode==='loading';hideAll();mode='error';q('#connection-error').hidden=false;
    announce('We couldn’t check your progress. Try again.');
    if(!wasLoading)q('#error-title').focus({preventScroll:true});
   }
  }finally{clearTimeout(timeout);polling=false;retry.disabled=false;}
 }
 function showCopied(button){
  const id=button.dataset.step;
  clearTimeout(copyTimers[id]);copyState[id]=true;
  button.querySelector('span').textContent='Copied';announce('Copied');
  copyTimers[id]=setTimeout(()=>{delete copyState[id];button.querySelector('span').textContent=button.dataset.label;delete copyTimers[id];},1500);
 }
 async function copy(button){
  const requestedStep=button.dataset.step;
  const value=q(`#${requestedStep}-prompt`).value;announce('');
  try{
   if(!navigator.clipboard?.writeText)throw Error('Clipboard unavailable');
   await navigator.clipboard.writeText(value);
   if(button.dataset.step!==requestedStep||mode!=='step')return;
   showCopied(button);
  }catch{
   if(button.dataset.step!==requestedStep||mode!=='step')return;
   manualTarget=requestedStep;hideAll();mode='manual';q('#manual-copy').hidden=false;q('#copy-fallback').value=value;q('#copy-fallback').focus();q('#copy-fallback').select();
   announce('Automatic copying is unavailable. Select and copy the prompt.');
  }
 }
 document.querySelectorAll('.copy-prompt').forEach(button=>button.addEventListener('click',()=>void copy(button)));
 q('#manual-next').addEventListener('click',()=>{paint();const button=q('[data-screen="connect"] .copy-prompt');button.focus();showCopied(button);});
 document.querySelectorAll('.prompt-toggle').forEach(button=>button.addEventListener('click',()=>{
  const expanded=button.getAttribute('aria-expanded')==='true';
  button.setAttribute('aria-expanded',String(!expanded));
  button.setAttribute('aria-label',button.getAttribute('aria-label').replace(expanded?'Hide':'Show',expanded?'Show':'Hide'));
  document.getElementById(button.getAttribute('aria-controls')).hidden=expanded;
 }));
 function clearSnippetFeedback(button){
  clearTimeout(snippetTimers.get(button));snippetTimers.delete(button);
  button.removeAttribute('data-copied');button.removeAttribute('data-copy-error');
  button.querySelector('.snippet-done').textContent='Copied';button.nextElementSibling.hidden=true;
 }
 document.querySelectorAll('.command-snippet').forEach(button=>button.addEventListener('click',async()=>{
  const value=button.dataset.copy;clearSnippetFeedback(button);announce('');
  try{
   if(!navigator.clipboard?.writeText)throw Error('Clipboard unavailable');
   await navigator.clipboard.writeText(value);
   if(button.dataset.copy!==value)return;
   button.setAttribute('data-copied','');announce('Copied');
  }catch{
   if(button.dataset.copy!==value)return;
   button.setAttribute('data-copy-error','');button.querySelector('.snippet-done').textContent='Selected';button.nextElementSibling.hidden=false;
   const range=document.createRange();range.selectNodeContents(button.querySelector('code'));
   const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);
   announce('Automatic copying is unavailable. The text is selected; copy it with your keyboard or selection menu.');
  }
  if(!button.hasAttribute('data-copy-error'))snippetTimers.set(button,setTimeout(()=>clearSnippetFeedback(button),1500));
 }));
 q('#retry-status').addEventListener('click',()=>void refresh());
 document.addEventListener('visibilitychange',()=>void refresh());window.addEventListener('online',()=>void refresh());
 const interval=setInterval(()=>void refresh(),5000);
 window.addEventListener('pagehide',()=>{clearInterval(interval);snippetTimers.forEach(clearTimeout);Object.values(copyTimers).forEach(clearTimeout);controller?.abort();});
 void refresh();
})();
