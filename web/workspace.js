import {requestJson} from './http.js';
const form=document.querySelector('#search-form');
const input=document.querySelector('#search-query');
const feedback=document.querySelector('#search-feedback');
const results=document.querySelector('#search-results');
const errorBox=document.querySelector('#workspace-error');
function element(tag, className, text) {
 const node=document.createElement(tag); node.className=className; node.textContent=text; return node;
}
form.addEventListener('submit', async event => {
 event.preventDefault(); const query=input.value.trim(); if(!query)return;
 const button=form.querySelector('button'),label=button.querySelector('span');
 button.disabled=true; label.textContent='Searching…'; errorBox.hidden=true; feedback.textContent='Searching your workspace…';
 try {
  const data=await requestJson('/api/workspace/search',{method:'POST',body:JSON.stringify({query})});
  results.replaceChildren(); document.querySelector('#search-start').hidden=true;
  feedback.textContent=data.results.length?`${data.results.length} ${data.results.length===1?'result':'results'} for “${query}”`:`No results for “${query}”. Try another phrase. New sources may still be indexing.`;
  if(data.partial)feedback.textContent+=' Some sources are temporarily unavailable.';
  for(const item of data.results) {
   const article=element('article','result','');
   article.append(element('span','result-source',item.source==='sessions'?'Coding session':item.provenance?.provider || 'Connected source'),element('h2','',item.title),element('p','',item.text));
   if(item.url) {
    try {const url=new URL(item.url); if(['https:','http:'].includes(url.protocol)){const link=element('a','result-link','Open source');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';article.append(link);}}catch{}
   }
   results.append(article);
  }
 } catch(error) {feedback.textContent='';errorBox.textContent=error.message;errorBox.hidden=false;}
 finally {button.disabled=false;label.textContent='Search';}
});
