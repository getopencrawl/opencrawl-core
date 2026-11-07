import {statusIcon as check,plusIcon as plus} from './icons.js';
import {requestJson as api} from './http.js';
import {requestSecret} from './secret-dialog.js';
const q=selector=>document.querySelector(selector);
const list=q('#connector-list'),query=q('#connector-query'),searchBox=q('.connector-search'),catalog=q('.connector-catalog'),next=q('#next-step');
let items=[],loaded=false,loading=false;
const pending=new Set(),errors=new Map();
const connected=item=>['connected','syncing','synced'].includes(item.state);
function announce(text){q('#sources-announcement').textContent=text;}
function render(){
 searchBox.hidden=!loaded||items.length<15;
 if(searchBox.hidden)query.value='';
 const filter=query.value.trim().toLocaleLowerCase();
 const matches=items.filter(item=>item.name.toLocaleLowerCase().includes(filter));
 const focusId=list.contains(document.activeElement)?document.activeElement.dataset.sourceId:null;
 list.replaceChildren();list.hidden=!loaded||!matches.length;
 q('#sources-empty').hidden=!loaded||matches.length>0;
 next.hidden=!loaded||!items.some(connected);
 for(const item of matches){
  const cell=document.createElement('li');cell.className='connector-cell';
  const logoSlot=document.createElement('span');logoSlot.className='connector-logo-slot';logoSlot.setAttribute('aria-hidden','true');
  if(item.icon){const logo=document.createElement('img');logo.className='connector-logo';logo.src=item.icon;logo.alt='';logo.width=32;logo.height=32;logoSlot.append(logo);}
  const name=document.createElement('span');name.className='connector-name';name.textContent=item.name;
  const button=document.createElement('button');button.type='button';button.className='connector-tile';button.dataset.sourceId=item.id;
  const status=document.createElement('span');status.className='connector-tile-status';status.setAttribute('aria-hidden','true');
  const done=connected(item),busy=pending.has(item.id);
  button.setAttribute('aria-disabled',String(done||busy));button.setAttribute('aria-label',`${done?'Connected to':busy?'Connecting to':'Connect'} ${item.name}`);
  if(busy)button.setAttribute('aria-busy','true');
  status.innerHTML=done||busy?check:plus;
  if(done)button.setAttribute('data-connected','');
  button.append(logoSlot,name,status);cell.append(button);
  if(errors.has(item.id)){const error=document.createElement('p');error.className='connector-tile-error';error.id=`connector-error-${item.id}`;error.setAttribute('role','alert');error.textContent=errors.get(item.id);button.setAttribute('data-error','');button.setAttribute('aria-describedby',error.id);cell.append(error);}
  list.append(cell);
 }
 if(focusId)[...list.querySelectorAll('button')].find(button=>button.dataset.sourceId===focusId)?.focus({preventScroll:true});
}
async function load(){
 if(loading)return;const restoreFocus=q('#retry-sources')===document.activeElement;loading=true;loaded=false;next.hidden=true;query.disabled=true;
 q('#sources-loading').hidden=false;q('#sources-error').hidden=true;q('#sources-empty').hidden=true;list.hidden=true;catalog.setAttribute('aria-busy','true');
 try{const data=await api('/api/onboarding/sources');if(!Array.isArray(data.items))throw Error();items=data.items;loaded=true;query.disabled=false;query.placeholder=`Search ${items.length} connectors…`;render();if(restoreFocus)(searchBox.hidden?list.querySelector('button')||q('#sources-title'):query).focus();}
 catch{q('#sources-error').hidden=false;}
 finally{loading=false;q('#sources-loading').hidden=true;catalog.setAttribute('aria-busy','false');}
}
async function refreshConnections() {
 const data = await api('/api/onboarding/sources');
 if (!Array.isArray(data.items)) throw Error('Invalid connector response');
 items = data.items; render();
}
list.addEventListener('click', async event => {
 const button = event.target.closest('button[data-source-id]');
 if (!button) return;
 const id = button.dataset.sourceId, item = items.find(item => item.id === id);
 if (!item || connected(item) || pending.has(id)) return;
 let apiKey;
 if (item.auth === 'api-key') {
  apiKey = await requestSecret({title:item.keyHelp?.title || `Connect ${item.name}`,body:item.keyHelp?.body || 'Use your workspace API key.',label:item.keyHelp?.label || 'API key',placeholder:item.keyHelp?.placeholder,action:`Connect ${item.name}`});
  if (!apiKey) return;
 }
 pending.add(id); errors.delete(id); render(); announce(`Connecting ${item.name}`);
 try {
  const result = await api(`/api/integrations/${encodeURIComponent(id)}/connect`, {method:'POST',body:JSON.stringify(apiKey?{apiKey}:{}),signal:AbortSignal.timeout(120000)});
  apiKey = null;
  if (result.redirectUrl) {
   const url = new URL(result.redirectUrl);
   if (url.protocol !== 'https:') throw Error('Invalid sign-in destination');
   location.assign(url.href); return;
  } else {
   await refreshConnections(); pending.delete(id); render(); announce(`${item.name} connected. Next is available.`);
  }
 } catch (error) {
  apiKey = null; pending.delete(id); errors.set(id,error.message); render(); announce(error.message);
 }
});
query.addEventListener('input',()=>{render();const count=items.filter(item=>item.name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())).length;announce(`${count} ${count===1?'connector':'connectors'} found`);});
q('#clear-connector-search').addEventListener('click',()=>{query.value='';render();query.focus();});
q('#retry-sources').addEventListener('click',()=>void load());
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void load();});
void load();
