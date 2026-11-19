import {useEffect,useRef,useState} from 'react';
import {Button,Field,Input,LoadingState,Notice,Section,Textarea} from '../design/components.js';
import type {LibraryAdapter,LibraryContract} from './library-types.js';
import {failureMessage,useResource} from './use-resource.js';

export function PrivacySettings({adapter}:{adapter:LibraryAdapter}) {
  const state=useResource(adapter,'privacy/status','',0,signal=>adapter('privacy/status',{},signal),'Could not load privacy settings.');
  if(!state.data)return state.error?<Notice tone="danger">{state.error} <Button onClick={state.retry}>Retry</Button></Notice>:<LoadingState label="Loading privacy settings"/>;
  return <PrivacyForm key={state.data.subject+state.data.revision} initial={state.data} adapter={adapter} saved={next=>state.replace(()=>next)}/>;
}
type Preference=LibraryContract['privacy/status']['output'];
function PrivacyForm({initial,adapter,saved}:{initial:Preference;adapter:LibraryAdapter;saved:(next:Preference)=>void}) {
  const [enabled,setEnabled]=useState(initial.enabled),[rules,setRules]=useState(initial.rules);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const pending=useRef<AbortController|null>(null);
  useEffect(()=>()=>pending.current?.abort(),[]);
  async function save(){
    if(pending.current)return;
    const request=new AbortController();
    pending.current=request;setBusy(true);setError('');
    try{
      const next=await adapter('privacy/change',{...initial,enabled,rules},request.signal);
      if(!request.signal.aborted)saved(next);
    }catch(failure){if(!request.signal.aborted)setError(failureMessage(failure,'Could not save privacy settings.'));}
    finally{if(!request.signal.aborted){pending.current=null;setBusy(false);}}
  }
  return <Section title="Session privacy">
    <form className="oc-stack" onSubmit={event=>{event.preventDefault();void save();}}>
      <label><Input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/> Automatically hide sensitive/personal sessions</label>
      <Field label="My privacy rules" hint="Describe what you want to keep private from your team.">
        <Textarea rows={3} maxLength={1500} value={rules} onChange={event=>setRules(event.target.value)}/>
      </Field>
      {error&&<Notice tone="danger">{error}</Notice>}
      <Button type="submit" variant="primary" busy={busy} disabled={enabled===initial.enabled&&rules===initial.rules}>Save changes</Button>
    </form>
  </Section>;
}
