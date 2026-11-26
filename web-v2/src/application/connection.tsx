import {EmptyState, LinkButton, LoadingState, Page, Section} from '../design/components.tsx';
import {useLocation} from '../router.tsx';
import {consoleResourceKey,useConsoleResource} from '../data.tsx';
import {SourceProgress, SourceStats} from './connector-card.tsx';
import type {SourcesAdapter} from './api.ts';

export function ConnectionPage({adapter}:{adapter:SourcesAdapter}) {
  const {pathname}=useLocation();
  const {data,error}=useConsoleResource([...consoleResourceKey(adapter,'integration-connection'),pathname],
    signal=>adapter.connection!(pathname,signal),{enabled:Boolean(adapter.connection)});
  if(error || !adapter.connection)return <Page title="Connection"><EmptyState title="Connection unavailable" description="This connection could not be opened in this workspace."/></Page>;
  if(!data)return <Page title="Connection"><LoadingState label="Loading connection"/></Page>;
  return <Page title={data.account || data.name} description={data.name} actions={<LinkButton to="/sources">Integrations</LinkButton>}>
    <Section title="Connection details">
      <p>{data.scope==='user'?'Personal connection':'Workspace connection'}</p>
      {data.connectedBy && <p>Connected by {data.connectedBy}</p>}
      <SourceProgress source={data}/>
      {Boolean(data.rows?.length) && <SourceStats source={data}/>}
    </Section>
  </Page>;
}
