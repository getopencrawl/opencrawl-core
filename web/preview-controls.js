const select=document.querySelector('#preview-scenario');
const apply=document.querySelector('#apply-preview');
const previous=document.querySelector('#previous-preview');
const next=document.querySelector('#next-preview');
const feedback=document.querySelector('#preview-feedback');
const sequence=['fresh','cli','connected','verified','complete','invite'];
let current='fresh',busy=false;
function sync(){
 const index=sequence.indexOf(current);
 apply.disabled=busy;select.disabled=busy;
 previous.disabled=busy||index===0;
 next.disabled=busy||index===sequence.length-1;
}
async function show(scenario){
 if(busy)return;
 busy=true;sync();feedback.textContent='';
 try{
  const response=await fetch('/__preview/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scenario})});
  if(!response.ok)throw Error();
  current=scenario;select.value=scenario;
  if(scenario.startsWith('invite')){location.assign('/onboarding/invite');return;}
  if(scenario.startsWith('source')){location.assign('/integrations');return;}
  if(scenario==='loading'){location.reload();return;}
  if(!['/','/onboarding'].includes(location.pathname))location.assign('/onboarding'+(location.search||'?variant=panel'));
  else{
   window.dispatchEvent(new Event('previewstatechange'));
   feedback.textContent=select.selectedOptions[0].textContent;
  }
 }catch{feedback.textContent='Couldn’t update the preview. Try again.';}
 finally{busy=false;sync();}
}
apply?.addEventListener('click',()=>void show(select.value));
previous?.addEventListener('click',()=>void show(sequence[Math.max(0,sequence.indexOf(current)-1)]));
next?.addEventListener('click',()=>void show(sequence[Math.min(sequence.length-1,sequence.indexOf(current)+1)]));
async function initialize(){
 busy=true;sync();
 try{
  const response=await fetch('/api/onboarding',{cache:'no-store'});
  if(!response.ok){if(response.status===503)current='error';else throw Error();}
  else{
   const {deriveOnboarding}=await import('./onboarding-state.js');
   const {data}=await response.json();
   current={connect:data.mcp?'mcp-only':'fresh',mcp:'cli',verify:'connected',session:data.history?.state==='complete'?'history-only':'verified',ready:data.history?.state==='importing'?'history-importing':data.history?.state==='complete'?'history-imported':data.history?.state==='skipped'?'history-skipped':'complete'}[deriveOnboarding(data).step];
  }
  if(location.pathname==='/integrations'&&current==='complete')current='sources';
  if(location.pathname==='/onboarding/invite'&&current==='complete')current='invite';
  select.value=current;
 }catch{feedback.textContent='Choose a state to start the preview.';}
 finally{busy=false;sync();}
}
if(apply)void initialize();

// Preview-only failure injection exercises the actual clipboard recovery UI.
const clipboardFailure=document.querySelector('#preview-clipboard-failure');
const originalClipboardDescriptor=Object.getOwnPropertyDescriptor(navigator,'clipboard');
function restoreClipboard(){if(originalClipboardDescriptor)Object.defineProperty(navigator,'clipboard',originalClipboardDescriptor);else delete navigator.clipboard;}
clipboardFailure?.addEventListener('change',()=>{
 if(clipboardFailure.checked)Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Simulated clipboard failure');}}});
 else restoreClipboard();
 feedback.textContent=clipboardFailure.checked?'Clipboard failure enabled':'Clipboard restored';
});
window.addEventListener('pagehide',restoreClipboard);
