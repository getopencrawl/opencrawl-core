import {statusIcon as check} from './icons.js';
import {requestJson} from './http.js';
const q=selector=>document.querySelector(selector);
const form=q('#invite-form'),field=q('#invite-emails'),button=q('#send-invites'),next=q('#next-step');
let busy=false;
function updateButton(){button.disabled=busy||!field.value.trim();button.textContent=busy?'Inviting…':'Invite';field.disabled=busy;}
function showError(message){q('#invite-error').textContent=message;q('#invite-error').hidden=false;}
function clearError(){q('#invite-error').textContent='';q('#invite-error').hidden=true;field.removeAttribute('aria-invalid');}
const api = options => requestJson('/api/onboarding/invites', options);
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
if (form) {
field.addEventListener('input',()=>{clearError();updateButton();});
form.addEventListener('submit',async event=>{
 event.preventDefault();if(busy)return;
 const email=field.value.trim().toLowerCase();
 if(!field.validity.valid||!email.slice(email.lastIndexOf('@')+1).includes('.')||email.length>254){showError('Enter one valid email address, like teammate@company.com.');field.setAttribute('aria-invalid','true');field.focus();return;}
 busy=true;updateButton();clearError();
 try{
  const data=await api({method:'POST',body:JSON.stringify({email})});render(data);field.value='';
  q('#invite-feedback').textContent=data.addedCount===0?'This teammate is already on the list.':'Invitation sent.';
  q('#invite-feedback').hidden=!q('#invite-feedback').textContent;
  q('#invite-feedback').classList.toggle('sr-only',data.addedCount!==0);
 }catch(error){showError(error.message);}
 finally{busy=false;updateButton();field.focus();}
});
q('#retry-invites').addEventListener('click',()=>void load());
updateButton();void load();
}
next.addEventListener('click', async event => {
 event.preventDefault(); if (next.getAttribute('aria-busy') === 'true') return;
 next.setAttribute('aria-busy','true');
 try { const result=await requestJson('/api/onboarding/finish',{method:'POST',body:'{}'}); location.assign(result.workspaceUrl); }
 catch(error) { const feedback=q('#invite-feedback') || document.createElement('p'); feedback.textContent=error.message; feedback.hidden=false; feedback.classList.remove('sr-only'); feedback.setAttribute('role','alert'); if(!feedback.parentNode)q('#invite-title').parentNode.append(feedback); next.removeAttribute('aria-busy'); }
});
