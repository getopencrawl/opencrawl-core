const main=document.querySelector('[data-page]');
const page=main?.dataset.page;
const errorBox=document.querySelector('#workspace-error');
async function api(path,options={}){
 const response=await fetch(path,{...options,headers:{'content-type':'application/json',...options.headers},signal:AbortSignal.timeout(10000)});
 if(response.status===403||response.redirected){const data=await response.json().catch(()=>({}));location.assign(data.onboardingUrl==='/integrations'?'/integrations':'/');throw Error('Complete setup to open your workspace.');}
 if(!response.ok)throw Error('We couldn’t load this. Please try again.');
 return response.json();
}
function showError(message){errorBox.textContent=message;errorBox.hidden=false;}
function clearError(){errorBox.hidden=true;}
function element(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;}
async function search(event){
 event?.preventDefault();
 const input=document.querySelector('#search-query'),query=input.value.trim();if(!query)return;
 const button=document.querySelector('#search-form button'),feedback=document.querySelector('#search-feedback'),results=document.querySelector('#search-results');
 button.disabled=true;button.textContent='Searching…';clearError();feedback.textContent='Searching your workspace…';
 try{
  const data=await api('/api/search',{method:'POST',body:JSON.stringify({query})});
  results.replaceChildren();document.querySelector('#search-start').hidden=true;
  const items=data.results||[];
  feedback.textContent=items.length?`${items.length} sample ${items.length===1?'result':'results'} for “${query}”`:`No results for “${query}”. Try a different phrase, or connect another source.`;
  for(const item of items){const article=element('article','result');article.append(element('span','result-source',item.source),element('h2','',item.title),element('p','',item.excerpt));results.append(article);}
 }catch(error){feedback.textContent='';showError(error.message);}finally{button.disabled=false;button.textContent='Search';}
}
if(page==='search'){
 document.querySelector('#search-form').addEventListener('submit',search);
 document.querySelector('#sample-query').addEventListener('click',()=>{document.querySelector('#search-query').value='What did we decide about onboarding?';void search();});
}
if(page==='usage')void (async()=>{try{const data=await api('/api/usage');const list=document.querySelector('#usage-values');list.replaceChildren();for(const [label,key] of [['Searches','queries'],['Sessions received','sessions'],['Sources connected','sources']]){const row=element('div');row.append(element('dt','',label),element('dd','',String(data[key]??0)));list.append(row);}}catch(error){showError(error.message);}})();
