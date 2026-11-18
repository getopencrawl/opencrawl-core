import {useEffect, useRef, useState} from 'react';
import {Button, Dialog} from '../design/components.js';
import type {LibraryAdapter, LibraryContract} from './library-types.js';
import {failureMessage,useResource} from './use-resource.js';

export function RecordingControl({adapter}: {adapter:LibraryAdapter}) {
  const state=useResource(adapter,'recording/status','',0,signal=>adapter('recording/status',{},signal),'Recording status unavailable.');
  const status=state.data&&'paused' in state.data?state.data:null;
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const pending=useRef<AbortController|null>(null);
  const reload=useRef(state.retry);
  reload.current=state.retry;
  useEffect(()=>()=>pending.current?.abort(),[adapter]);
  useEffect(()=>{
    const until=status?.until;
    if(!status?.paused || until==null)return;
    const timer=window.setTimeout(()=>reload.current(),Math.max(0,until-Date.now())+100);
    return ()=>window.clearTimeout(timer);
  },[status?.revision,status?.paused,status?.until]);
  async function change(mode:LibraryContract['recording/change']['input']['mode']){
    if(!status||pending.current)return;
    const request=new AbortController();
    pending.current=request; setBusy(true); setError('');
    try{
      const next=await adapter('recording/change',{mode,revision:status.revision},request.signal);
      if(!request.signal.aborted){state.replace(()=>next);setOpen(false);}
    }catch(failure){
      if(!request.signal.aborted){setError(failureMessage(failure,'Could not update recording. Try again.'));state.retry();}
    }finally{if(!request.signal.aborted){pending.current=null;setBusy(false);}}
  }
  if(state.data&&'available' in state.data)return null;
  if(!status)return state.error
    ? <Button variant="secondary" onClick={state.retry}>Retry recording status</Button>
    : <Button variant="secondary" disabled>Checking recording…</Button>;
  const paused=status.paused;
  return <div className="oc-stack">
    {paused&&<span role="status">{status.until==null?'Recording paused':`Paused until ${new Date(status.until).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}`}</span>}
    <Button variant="secondary" disabled={busy} onClick={()=>paused?void change('resume'):setOpen(true)}>{paused?'Resume recording':'Pause recording'}</Button>
    {!open&&error&&<span role="alert">{error}</span>}
    <Dialog open={open} onClose={()=>{if(!busy)setOpen(false);}} title="Pause recording" description="Applies to every agent signed in as you. Activity during the pause stays out of OpenCrawl when recording resumes.">
      <div className="oc-stack">
        <Button disabled={busy} onClick={()=>void change('hour')}>For 1 hour</Button>
        <Button disabled={busy} onClick={()=>void change('indefinite')}>Until I turn it back on</Button>
        {error&&<span role="alert">{error}</span>}
      </div>
    </Dialog>
  </div>;
}
