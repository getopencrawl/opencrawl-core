import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Button,Dialog,Field,Input,Notice} from '../index.ts';
import type {ReplicasImportStatus} from '../../../src/integrations/replicas-import.mjs';
import type {SourcesAdapter} from './api.ts';
import {failureMessage} from './errors.ts';

export function ReplicasHistoryDialog({adapter,onClose,onConnected}:{adapter:SourcesAdapter;onClose:()=>void;onConnected:(result:ReplicasImportStatus)=>void}){
  const [key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const active=useRef<AbortController|null>(null);
  useEffect(()=>()=>active.current?.abort(),[]);
  async function connect(event:FormEvent){
    event.preventDefault();
    if(active.current||!adapter.replicasHistory||!key.trim())return;
    const request=new AbortController();
    active.current=request;setBusy(true);setError('');
    try{
      const result=await adapter.replicasHistory({action:'connect',apiKey:key.trim()},request.signal);
      if(!request.signal.aborted)onConnected(result);
    }catch(failure){if(!request.signal.aborted)setError(failureMessage(failure));}
    finally{active.current=null;if(!request.signal.aborted)setBusy(false);}
  }
  return <Dialog open onClose={onClose} title="Connect Replicas" description="Import your organization’s session history.">
    <form className="stack" onSubmit={connect}>
      <p>In Replicas, turn on <strong>Team workspace visibility</strong> in Organization settings → Preferences. Then create an organization key in <a href="https://app.replicas.dev/dashboard/settings?tab=api-keys" target="_blank" rel="noreferrer">API Keys</a>.</p>
      <Field label="Organization API key"><Input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event=>setKey(event.target.value)} required/></Field>
      {error&&<Notice tone="danger">{error}</Notice>}
      <div className="actions"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={busy||!key.trim()}>{busy?'Connecting…':'Connect'}</Button></div>
    </form>
  </Dialog>;
}
