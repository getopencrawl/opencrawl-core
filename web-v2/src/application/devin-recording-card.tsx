import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Button,Dialog,ExternalLink,Field,Input,IntegrationCard,LinkButton,Notice} from '../design/components.tsx';
import {failureMessage} from './errors.ts';
import type {SourceCard,SourcesAdapter} from './api.ts';

export function DevinRecordingCard({source,mutate,onChange}:{
  source: SourceCard; mutate: NonNullable<SourcesAdapter['devinRecording']>; onChange: () => void;
}) {
  const connection = source.devinRecording;
  const connected = !!connection && connection.health !== 'disconnected';
  const [dialog,setDialog] = useState<'connect'|'manage'|null>(null);
  const [key,setKey] = useState(''), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const active = useRef<AbortController|null>(null);
  useEffect(()=>()=>active.current?.abort(),[]);
  function close() {if (!active.current) {setDialog(null);setKey('');setError('');}}
  async function submit(action:'connect'|'disconnect', event?:FormEvent) {
    event?.preventDefault();
    if (active.current || (action==='disconnect' && !connection) || (action==='connect' && !key.trim())) return;
    const controller = new AbortController();
    active.current=controller;setBusy(true);setError('');
    try {
      await mutate(action==='connect' ? {action,record:true,serviceKey:key.trim()} : {action,generation:connection!.generation},controller.signal);
      if (!controller.signal.aborted) {setKey('');setDialog(null);onChange();}
    } catch (failure) {
      if (!controller.signal.aborted) setError(failureMessage(failure));
    } finally {active.current=null;if (!controller.signal.aborted) setBusy(false);}
  }
  const latest = connection?.latestSession;
  const capture = connection?.health==='needs-key' ? 'Recording stopped. Update the service-user key.'
    : connection?.capture==='delayed' ? 'Recording is delayed. OpenCrawl will retry automatically.'
    : connection?.capture==='indexing' ? 'The first session is being indexed.'
    : connection?.capture==='recording' ? 'Recording new sessions.' : 'Waiting for the first indexed session.';
  const link = latest && (latest.permalinkId ? '/sessions/'+latest.permalinkId : '/sessions?'+new URLSearchParams({user:latest.userId,harness:latest.harness,id:latest.sessionId}));
  return <>
    <IntegrationCard name="Devin" icon="/assets/integrations/devin.png" compact={!connected}
      status={{label:connection?.health==='needs-key'?'Key expired or revoked':'Connected',tone:connection?.health==='needs-key'?'danger':'success'}}
      note={connected && <div className="stack"><p className="oc-integration-empty">{capture}</p>
        {link && <div className="actions"><LinkButton to={link}>View indexed session</LinkButton></div>}</div>}
      metadata={connection?.health==='needs-key'?'Needs a new key':'Connected'}
      action={<Button variant={connected?'secondary':'primary'} aria-label={connected?'Manage Devin':'Connect Devin'} onClick={()=>setDialog(connected?'manage':'connect')}>{connected?'Manage':'Connect'}</Button>}/>
    {dialog==='connect' && <Dialog open onClose={close} title="Connect Devin" description="New sessions this key can read will be searchable by members of this OpenCrawl workspace.">
      <form className="stack" onSubmit={event=>void submit('connect',event)}>
        <p>OpenCrawl records prompts, replies, and available tool activity, including shell commands and output excerpts. Recording starts when you connect.</p>
        <Field label="Organization service-user key" hint={<span>Open <ExternalLink href="https://app.devin.ai/settings/devin-api?tab=service-users">Service users in Devin</ExternalLink>. In the organization you want to record, create a service user whose role can view organization sessions.</span>}>
          <Input type="password" autoComplete="off" spellCheck={false} required value={key} onChange={event=>setKey(event.target.value)}/>
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="actions"><Button disabled={busy} onClick={close}>Cancel</Button><Button type="submit" variant="primary" disabled={busy||!key.trim()}>{busy?'Connecting…':'Connect and record'}</Button></div>
      </form>
    </Dialog>}
    {dialog==='manage' && connection && <Dialog open onClose={close} title="Manage Devin" description={connection.organization}>
      <div className="stack">
        <p>{capture}</p>
        <ExternalLink href="https://docs.getopencrawl.com/agents/devin/">Install OpenCrawl tools inside Devin</ExternalLink>
        <p>Disconnecting stops new capture. Previously indexed sessions stay in this workspace.</p>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="actions"><Button disabled={busy} onClick={()=>{setError('');setDialog('connect');}}>Update key</Button><Button disabled={busy} variant="danger" onClick={()=>void submit('disconnect')}>{busy?'Disconnecting…':'Disconnect'}</Button></div>
      </div>
    </Dialog>}
  </>;
}
