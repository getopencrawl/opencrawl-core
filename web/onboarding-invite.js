import {parseInvitationEmails} from './invitation-emails.js';
const q=selector=>document.querySelector(selector);
const form=q('#invite-form'),field=q('#invite-emails'),button=q('#send-invites'),next=q('#next-step');
const check='<svg class="signal-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>';
let busy=false;
function updateButton(){button.disabled=busy||!field.value.trim();button.textContent=busy?'Inviting…':'Invite';field.disabled=busy;}
function showError(message){q('#invite-error').textContent=message;q('#invite-error').hidden=false;}
function clearError(){q('#invite-error').textContent='';q('#invite-error').hidden=true;field.removeAttribute('aria-invalid');}
async function api(options={}){
 const response=await fetch('/api/onboarding/invites',{credentials:'same-origin',cache:'no-store',...options,headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10000)});
 if(response.status===403){location.assign('/integrations');throw Error('Complete source setup first.');}
 const data=await response.json().catch(()=>({}));if(!response.ok)throw Error(data.error||'We couldn’t send your invitations. Try again.');
 if(!Array.isArray(data.items))throw Error('We couldn’t update invitations. Try again.');return data;
}
function render(data){
 const list=q('#invitation-list');list.replaceChildren();list.hidden=!data.items.length;
 for(const invitation of data.items){
  const row=document.createElement('li');row.innerHTML=check;
  const email=document.createElement('span');email.className='invitation-email';email.textContent=invitation.email;
  row.append(email);list.append(row);
 }
 const invited=data.items.length>0;next.querySelector('[data-next-label]').textContent=invited?'Open workspace':'Skip for now';
 next.classList.toggle('primary',invited);next.classList.toggle('onboarding-skip',!invited);
}
async function load(){
 const retry=q('#retry-invites');retry.disabled=true;q('#invite-load-error').hidden=true;
 try{render(await api());}catch{q('#invite-load-error').hidden=false;}finally{retry.disabled=false;}
}
field.addEventListener('input',()=>{clearError();updateButton();});
form.addEventListener('submit',async event=>{
 event.preventDefault();if(busy)return;
 const {emails,error}=parseInvitationEmails(field.value);
 if(error||emails.length!==1||!field.validity.valid){showError('Enter one valid email address, like teammate@company.com.');field.setAttribute('aria-invalid','true');field.focus();return;}
 busy=true;updateButton();clearError();
 try{
  const data=await api({method:'POST',body:JSON.stringify({emails})});render(data);field.value='';
  q('#invite-feedback').textContent=data.addedCount===0?'This teammate is already on the list.':data.simulated?'':'Invitation sent.';
  q('#invite-feedback').hidden=!q('#invite-feedback').textContent;
 }catch(error){showError(error.message);}
 finally{busy=false;updateButton();field.focus();}
});
q('#retry-invites').addEventListener('click',()=>void load());
updateButton();void load();
