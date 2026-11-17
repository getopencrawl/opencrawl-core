import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Button,Dialog,Field,Input,Notice} from '../index.ts';
import type {ReplicasImportStatus,ReplicasImportInput} from '../../../src/integrations/replicas-import.mjs';
import type {SourcesAdapter} from './api.ts';
import {ConsoleApiError,failureMessage} from './errors.ts';

export function ReplicasHistoryDialog({adapter,initial,onClose,onChange}:{adapter:SourcesAdapter;initial?:ReplicasImportStatus;onClose:()=>void;onChange:()=>void}){
  const [status,setStatus]=useState(initial),[key,setKey]=useState(''),[addingKey,setAddingKey]=useState(!initial||initial.phase==='disconnected'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const active=useRef<AbortController|null>(null);
  useEffect(()=>()=>{active.current?.abort();active.current=null;},[]);
  function pause(){active.current?.abort();active.current=null;setBusy(false);onChange();}
  async function act(input:ReplicasImportInput,run=false){
    if(active.current||!adapter.replicasHistory)return;
    const controller=new AbortController();active.current=controller;setBusy(true);setError('');
    try{
      let next=await adapter.replicasHistory(input,controller.signal);
      if(controller.signal.aborted)return;
      setKey('');setAddingKey(false);setStatus(next);onChange();
      while(run&&next.phase==='importing'&&!controller.signal.aborted){
        next=await adapter.replicasHistory({action:'step',id:next.id},controller.signal);
        if(controller.signal.aborted)return;
        setStatus(next);
      }
      if(!controller.signal.aborted)onChange();
    }catch(failure){if(!controller.signal.aborted){if(failure instanceof ConsoleApiError&&[401,402,403].includes(failure.status)){setKey('');setStatus(undefined);onClose();onChange();}else setError(failureMessage(failure));}}
    finally{if(active.current===controller){active.current=null;setBusy(false);}}
  }
  function submit(event:FormEvent){event.preventDefault();void act({action:'preview',apiKey:key.trim()});}
  return <Dialog open onClose={()=>{pause();onClose();}} title="Import Replicas history" description="Read retained conversations directly, including sleeping and archived replicas. This does not wake replicas or start agents.">
    <div className="stack">
      {addingKey?<form className="stack" onSubmit={submit}>
        <Field label="Replicas organization API key" hint="An admin creates this in Replicas → Settings → API Keys. Personal API keys cannot export organization history."><Input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event=>setKey(event.target.value)} required/></Field>
        <p>The key is encrypted on the server and removed when the import finishes. Previewing does not import messages.</p>
        <div className="actions"><Button disabled={busy} onClick={()=>{pause();onClose();}}>Cancel</Button><Button type="submit" variant="primary" disabled={busy||!key.trim()}>{busy?'Checking history…':'Preview history'}</Button></div>
      </form>:status&&<>
        <p><strong>{status.organization.name}</strong>, {status.total.toLocaleString()} retained conversations reported by Replicas.</p>
        {status.phase==='preview'&&<>
          <p>Import Claude and Codex conversation messages into this OpenCrawl workspace, where workspace members can search them. Deleted or expired chats, other agents, tool output, and attachments are not included. Missing authors remain unknown.</p>
          <p>The organization key must have access to each workspace. Personal-workspace history requires Team workspace visibility in Replicas; enabling that setting also makes those workspaces visible to other organization members.</p>
          <Notice>Previously captured live sessions may overlap with this history. Repeating this historical import does not duplicate its stored messages.</Notice>
          {status.sample.length>0&&<ul>{status.sample.map((chat,index)=><li key={index}>{chat.title} — {chat.workspace} ({chat.provider??'unknown agent'})</li>)}</ul>}
          <p>Keep this page open during import. You can pause and resume from the saved checkpoint.</p>
        </>}
        {status.phase!=='preview'&&<p role="status">{status.processed.toLocaleString()} chats checked, {status.imported.toLocaleString()} imported, {status.skipped.toLocaleString()} skipped, {status.messages.toLocaleString()} messages read</p>}
        {status.phase==='complete'&&<Notice tone={status.imported>0&&status.unavailable===0?'success':'warning'}>{status.imported>0?'History import finished. Imported messages have been handed to search indexing.':'No messages were imported.'} The API key has been removed.</Notice>}
        {status.skipped>0&&<Notice>{status.unavailable??0} chats were unavailable to this key, {status.unsupported??0} used unsupported agents, and {status.skipped-(status.unavailable??0)-(status.unsupported??0)} contained no readable text messages.{status.unavailable>0?' Check Team workspace visibility and data retention in Replicas before importing again.':''}</Notice>}
        {status.phase==='importing'&&<p>{busy?'Importing history… Closing this dialog pauses after the current page.':'Import paused. Resume to continue from the saved checkpoint.'}</p>}
        {status.phase==='disconnected'&&<p>The key was removed. Previously imported history remains in OpenCrawl.</p>}
        <div className="actions">{busy?<Button onClick={pause}>Pause import</Button>:<>
          {['preview','importing'].includes(status.phase)&&<Button onClick={()=>void act({action:'disconnect',id:status.id})}>Remove key</Button>}
          {status.phase==='preview'&&<Button variant="primary" onClick={()=>void act({action:'start',id:status.id},true)}>Import into this workspace</Button>}
          {status.phase==='importing'&&<Button variant="primary" onClick={()=>void act({action:'step',id:status.id},true)}>Resume import</Button>}
          {['complete','disconnected'].includes(status.phase)&&<Button onClick={()=>setAddingKey(true)}>Import again</Button>}
        </>}</div>
        {['preview','importing'].includes(status.phase)&&<p>Removing the key stops this import. History already imported remains in OpenCrawl.</p>}
      </>}
      {error&&<Notice tone="danger">{error}</Notice>}
    </div>
  </Dialog>;
}
