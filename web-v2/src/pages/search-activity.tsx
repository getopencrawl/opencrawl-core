import {useState} from 'react';
import {consoleResourceKey,useConsoleResource} from '../data.tsx';
import {Button,EmptyState,LoadingState,MetricGrid,Notice,Section,Table} from '../design/components.js';
import {Link} from '../router.js';
import type {ConsoleDataAdapter} from './types.js';
import type {HistoryRequest,SearchActivityRow} from '../../../src/application/search-activity.mjs';
import {count,harnessName} from './usage-model.ts';

const refresh={autoRefreshMilliseconds:60_000,staleMilliseconds:60_000};
const dateFormat=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'});
type ActivityAdapter=Required<Pick<ConsoleDataAdapter,'callTotals'|'searchHistory'>>;

function SearchSession({row}:{row:SearchActivityRow}) {
  if(!row.sessionId)return <>Unavailable</>;
  const params=new URLSearchParams({user:row.userId,harness:row.harness??'',id:row.sessionId});
  return row.harness?<Link to={'/sessions?'+params}>{harnessName(row.harness)} <code>{row.sessionId}</code></Link>:<code>{row.sessionId}</code>;
}

function scoped<T extends {cacheScope:string}>(scope:string,result:T){
  if(scope!==result.cacheScope)throw Object.assign(new Error('Your workspace changed. Reload this page.'),{status:403});
  return result;
}

function SearchTable({adapter,kind,scope}:{adapter:ActivityAdapter;scope:string;kind:HistoryRequest['kind']}) {
  const [cursors,setCursors]=useState<NonNullable<HistoryRequest['before']>[]>([]);
  const before=cursors.at(-1);
  const {data,error,loading,reload}=useConsoleResource([...consoleResourceKey(adapter,'search-history'),kind,before],
    async signal=>scoped(scope,await adapter.searchHistory({kind,...before?{before}:{}},signal)),{...refresh,staleMilliseconds:0});
  const proactive=kind==='proactive';
  const title=proactive?'Proactive searches':'Agent searches';
  return <Section headingLevel={3} className="report-panel" title={title} description="Newest first. Shared sessions and your own searches.">
    {error&&<Notice tone="warning">Search history couldn’t update. <Button onClick={reload}>Try again</Button></Notice>}
    {loading&&<LoadingState label={'Loading '+title.toLowerCase()}/>}
    {data&&!error&&(data.rows.length?<Table label={title} className="usage-search-history"><thead><tr><th scope="col">Time</th><th scope="col">Search</th>
      <th scope="col">Session</th>{proactive&&<th scope="col">Triggering message</th>}<th scope="col">Outcome</th></tr></thead>
      <tbody>{data.rows.map(row=><tr key={row.id}>
        <td><time dateTime={row.at} title={row.at}>{dateFormat.format(new Date(row.at))}</time></td>
        <td>{!proactive&&<span className="report-email">{row.operation}</span>}{row.queries.length?row.queries.join('\n'):proactive||row.outcome==='unknown'?'Query unavailable in earlier record':'No query text'}</td>
        <td><SearchSession row={row}/><span className="report-email">{row.userId}</span></td>
        {proactive&&<td>{row.message}<span className="report-email">{row.messageId??'Message unavailable'}</span></td>}
        <td>{row.outcome==='unknown'?'Outcome unavailable':row.outcome==='failed'?'Failed':!proactive?'Completed':row.delivered?'Handed to agent':row.returned?'Non-silent':'Silent'}</td>
      </tr>)}</tbody></Table>:<EmptyState title={data.next||before?'No visible searches on this page.':proactive?'No visible proactive searches in this period.':'No visible agent searches in this period.'}/>)}
    {cursors.length>0&&<Button onClick={()=>setCursors(previous=>previous.slice(0,-1))}>Newer searches</Button>}
    {data?.next&&<Button onClick={()=>setCursors(previous=>[...previous,data.next!])}>Older searches</Button>}
  </Section>;
}

export function SearchActivity({adapter,scope}:{adapter:ActivityAdapter;scope:string}){
  const {data,error,reload}=useConsoleResource(consoleResourceKey(adapter,'call-totals'),async signal=>scoped(scope,await adapter.callTotals(signal)),refresh);
  return <Section className="report-section" title="OpenCrawl activity" description={data?'Last 30 UTC days. Full call and agent search tracking began '+dateFormat.format(new Date(data.since))+'.'+(data.includesEarlierCalls?' Includes verified earlier calls.':''):undefined}>
    {error&&<Notice tone="warning">Call totals couldn’t update. <Button onClick={reload}>Try again</Button></Notice>}
    {data&&<MetricGrid items={[
      {label:'OpenCrawl calls',value:count(data.calls),note:'Authenticated agent calls across the workspace'},
      {label:'Agent searches',value:count(data.agentSearches),note:'Search calls from workspace agents'},
      {label:'Proactive checks',value:count(data.proactiveChecks),note:'Checks that ran a search for workspace agents'},
      {label:'Non-silent checks',value:count(data.nonSilent),note:count(data.delivered)+' confirmed handoffs',help:'A non-silent check returned a suggestion. A confirmed handoff means the agent’s hook reported writing it into context.'},
    ]}/>}
    <SearchTable adapter={adapter} scope={scope} kind="agent"/><SearchTable adapter={adapter} scope={scope} kind="proactive"/>
  </Section>;
}
